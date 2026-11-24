import * as vscode from 'vscode';
import { AGY_BEFORE_QUERY_PARAM, stripAgyBeforeQuery } from './agyEditTracker.js';

type ChatPart = Parameters<vscode.ChatResponseStream['push']>[0];

export interface CarouselPromptResolution {
  readonly answered: boolean;
  readonly answers: Record<string, unknown> | undefined;
}

interface PendingCarouselInteraction {
  readonly questions: readonly vscode.ChatQuestion[];
  readonly allowSkip: boolean;
  readonly questionIds: ReadonlySet<string>;
  readonly deferred: PromiseWithResolvers<CarouselPromptResolution>;
  readonly emittedStreams: WeakSet<vscode.ChatResponseStream>;
  settled: boolean;
  stopSubscription?: vscode.Disposable | undefined;
}

export class ActiveAgyTurn {
  private readonly parts = new Set<ChatPart>();
  private readonly pendingCarousels = new Map<string, PendingCarouselInteraction>();
  private readonly completed = Promise.withResolvers<void>();
  private readonly switchedView = Promise.withResolvers<void>();
  private readonly stopSource = new vscode.CancellationTokenSource();
  private stream: vscode.ChatResponseStream | undefined;
  private requestStream: vscode.ChatResponseStream | undefined;
  private interruptionToken: vscode.CancellationToken | undefined;
  private lastUsage: vscode.ChatResponseUsage | undefined;
  private reattached = false;
  private finished = false;

  public constructor(
    public readonly history: vscode.ChatSession['history'],
    stream: vscode.ChatResponseStream,
    private readonly stopPrompt: () => void,
  ) {
    this.stream = stream;
    this.requestStream = stream;
  }

  public get permissionStream(): vscode.ChatResponseStream | undefined {
    return this.stopToken.isCancellationRequested ? undefined : this.requestStream;
  }

  public get isReattached(): boolean {
    return this.reattached;
  }

  public hasInteractiveQuestionCarousel(): boolean {
    return typeof this.stream?.questionCarousel === 'function';
  }

  public get stopToken(): vscode.CancellationToken {
    return this.stopSource.token;
  }

  public get onViewSwitched(): Promise<void> {
    return this.switchedView.promise;
  }

  public push(part: ChatPart): void {
    // Tool and plan updates reuse mutable part objects; replay each once in its original position.
    this.parts.add(part);
    this.send(part);
  }

  public usage(usage: vscode.ChatResponseUsage): void {
    this.lastUsage = usage;
    this.sendUsage(usage);
  }

  public async externalEdit(uri: vscode.Uri, write: () => Promise<void>, onTracked: () => void): Promise<void> {
    const stream = this.stream;
    if (stream === undefined || typeof stream.externalEdit !== 'function' || this.stopToken.isCancellationRequested) {
      await write();
      return;
    }

    const state = { started: false };
    let writing: Promise<void> | undefined;
    const writeOnce = async (): Promise<void> => {
      writing ??= Promise.resolve().then(write);
      await writing;
    };
    const hasAgyBefore = typeof uri.query === 'string' && uri.query.includes(`${AGY_BEFORE_QUERY_PARAM}=`);
    try {
      const undoStopId = await stream.externalEdit(uri, async () => {
        state.started = true;
        await writeOnce();
      });
      await writeOnce();
      if (state.started) {
        onTracked();
        if (!hasAgyBefore) {
          this.rememberExternalEdit(stripAgyBeforeQuery(uri), undoStopId, stream);
        }
      }
    } catch {
      // If the UI failed before or after the callback, reuse the same write. A
      // failed write remains failed; an already successful write is never repeated.
      await writeOnce();
    }
  }

  private rememberExternalEdit(uri: vscode.Uri, undoStopId: string, source: vscode.ChatResponseStream): void {
    if (
      typeof vscode.ChatResponseCodeblockUriPart !== 'function' ||
      typeof vscode.ChatResponseTextEditPart !== 'function'
    ) {
      return;
    }
    const replayParts = [
      new vscode.ChatResponseMarkdownPart('\n````\n'),
      new vscode.ChatResponseCodeblockUriPart(uri, true, undoStopId),
      new vscode.ChatResponseTextEditPart(uri, []),
      new vscode.ChatResponseTextEditPart(uri, true),
      new vscode.ChatResponseMarkdownPart('\n````\n'),
    ] as unknown as ChatPart[];
    for (const part of replayParts) {
      this.parts.add(part);
      if (this.stream !== source) {
        this.send(part);
      }
    }
  }

  public readonly attach = async (
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const supportsInteractiveCarousel = typeof stream.questionCarousel === 'function';
    if (!this.finished) {
      this.reattached = true;
      if (supportsInteractiveCarousel) {
        this.requestStream = stream;
      } else {
        this.requestStream = undefined;
        this.switchedView.resolve();
      }
    }
    this.stream = stream;
    for (const part of this.parts) {
      this.send(part);
    }
    if (this.lastUsage !== undefined) {
      this.sendUsage(this.lastUsage);
    }
    if (this.finished) {
      this.stream = undefined;
      return;
    }

    for (const entry of this.pendingCarousels.values()) {
      if (supportsInteractiveCarousel) {
        this.presentCarouselOnStream(stream, entry);
      } else {
        this.settlePendingCarousel(entry, { answered: false, answers: undefined });
      }
    }

    // VS Code defers disposal of a live active response until it is interrupted.
    // This is the interruption token, not the cancellable history-load token.
    this.interruptionToken = token;
    const subscription = token.onCancellationRequested(() => {
      if (this.interruptionToken === token) {
        this.stop();
      }
    });
    try {
      if (token.isCancellationRequested) {
        this.stop();
      }
      await this.completed.promise;
    } finally {
      subscription.dispose();
    }
  };

  public async requestQuestionCarousel(
    interactionId: string,
    questions: readonly vscode.ChatQuestion[],
    allowSkip: boolean,
  ): Promise<CarouselPromptResolution> {
    if (this.finished || this.stopToken.isCancellationRequested) {
      return { answered: false, answers: undefined };
    }

    const questionIds = new Set(questions.map((question) => question.id));
    const entry: PendingCarouselInteraction = {
      questions: [...questions],
      allowSkip,
      questionIds,
      deferred: Promise.withResolvers<CarouselPromptResolution>(),
      emittedStreams: new WeakSet<vscode.ChatResponseStream>(),
      settled: false,
    };
    this.pendingCarousels.set(interactionId, entry);
    entry.stopSubscription = this.stopToken.onCancellationRequested(() => {
      this.settlePendingCarousel(entry, { answered: false, answers: undefined });
    });

    const activeStream = this.stream;
    if (activeStream !== undefined && typeof activeStream.questionCarousel === 'function') {
      this.presentCarouselOnStream(activeStream, entry);
    }

    return await entry.deferred.promise;
  }

  public resolvePendingCarousel(payload: {
    readonly questionIds?: readonly string[] | undefined;
    readonly answers?: Record<string, unknown> | undefined;
  }): boolean {
    const answerKeys = payload.answers !== undefined ? Object.keys(payload.answers) : [];
    const candidateIds =
      payload.questionIds !== undefined && payload.questionIds.length > 0 ? payload.questionIds : answerKeys;

    for (const entry of this.pendingCarousels.values()) {
      if (candidateIds.some((id) => entry.questionIds.has(id))) {
        this.settlePendingCarousel(entry, { answered: true, answers: payload.answers });
        return true;
      }
    }

    if (candidateIds.length === 0 && this.pendingCarousels.size === 1) {
      const onlyEntry = this.pendingCarousels.values().next().value;
      if (onlyEntry !== undefined) {
        this.settlePendingCarousel(onlyEntry, { answered: true, answers: payload.answers });
        return true;
      }
    }

    return false;
  }

  private presentCarouselOnStream(targetStream: vscode.ChatResponseStream, entry: PendingCarouselInteraction): void {
    if (entry.settled || this.finished || typeof targetStream.questionCarousel !== 'function') {
      return;
    }
    if (entry.emittedStreams.has(targetStream)) {
      return;
    }
    entry.emittedStreams.add(targetStream);

    let carouselPromise: Thenable<Record<string, unknown> | undefined>;
    try {
      carouselPromise = targetStream.questionCarousel([...entry.questions], entry.allowSkip);
    } catch {
      return;
    }

    void Promise.resolve(carouselPromise).then(
      (answers) => {
        if (entry.settled) {
          return;
        }
        if (answers !== undefined && Object.keys(answers).length > 0) {
          this.settlePendingCarousel(entry, { answered: true, answers });
          return;
        }
        if (this.stream !== targetStream || this.stopToken.isCancellationRequested) {
          return;
        }
        this.settlePendingCarousel(entry, { answered: true, answers: undefined });
      },
      () => {
        // Stream failure / detachment must keep the interaction pending until reattached or answered.
      },
    );
  }

  private settlePendingCarousel(entry: PendingCarouselInteraction, resolution: CarouselPromptResolution): void {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    entry.stopSubscription?.dispose();
    entry.stopSubscription = undefined;
    for (const [key, candidate] of this.pendingCarousels.entries()) {
      if (candidate === entry) {
        this.pendingCarousels.delete(key);
      }
    }
    entry.deferred.resolve(resolution);
  }

  public stop(): void {
    if (!this.finished && !this.stopToken.isCancellationRequested) {
      this.stopSource.cancel();
      this.switchedView.resolve();
      for (const entry of [...this.pendingCarousels.values()]) {
        this.settlePendingCarousel(entry, { answered: false, answers: undefined });
      }
      this.stopPrompt();
    }
  }

  public stopRequestStream(stream: vscode.ChatResponseStream): void {
    if (this.requestStream === stream && !this.reattached) {
      this.stop();
    }
  }

  public finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.stream = undefined;
    this.requestStream = undefined;
    this.interruptionToken = undefined;
    this.stopSource.cancel();
    this.stopSource.dispose();
    this.switchedView.resolve();
    for (const entry of [...this.pendingCarousels.values()]) {
      this.settlePendingCarousel(entry, { answered: false, answers: undefined });
    }
    this.completed.resolve();
  }

  private send(part: ChatPart): void {
    try {
      this.stream?.push(part);
    } catch {
      // A closed UI stream must not prevent ACP progress or file-change tracking.
      this.stream = undefined;
      this.requestStream = undefined;
      this.switchedView.resolve();
    }
  }

  private sendUsage(usage: vscode.ChatResponseUsage): void {
    try {
      this.stream?.usage(usage);
    } catch {
      // A closed UI stream must not prevent ACP progress or file-change tracking.
      this.stream = undefined;
      this.requestStream = undefined;
      this.switchedView.resolve();
    }
  }
}
