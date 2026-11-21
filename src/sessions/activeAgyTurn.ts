import * as vscode from 'vscode';

type ChatPart = Parameters<vscode.ChatResponseStream['push']>[0];

export class ActiveAgyTurn {
  private readonly parts = new Set<ChatPart>();
  private readonly completed = Promise.withResolvers<void>();
  private readonly switchedView = Promise.withResolvers<void>();
  private readonly stopSource = new vscode.CancellationTokenSource();
  private stream: vscode.ChatResponseStream | undefined;
  private requestStream: vscode.ChatResponseStream | undefined;
  private interruptionToken: vscode.CancellationToken | undefined;
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
    try {
      const undoStopId = await stream.externalEdit(uri, async () => {
        state.started = true;
        await writeOnce();
      });
      await writeOnce();
      if (state.started) {
        onTracked();
        this.rememberExternalEdit(uri, undoStopId, stream);
      }
    } catch {
      // If the UI failed before or after the callback, reuse the same write. A
      // failed write remains failed; an already successful write is never repeated.
      await writeOnce();
    }
  }

  private rememberExternalEdit(uri: vscode.Uri, undoStopId: string, source: vscode.ChatResponseStream): void {
    if (typeof vscode.ChatResponseCodeblockUriPart !== 'function' || typeof vscode.ChatResponseTextEditPart !== 'function') {
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
    if (!this.finished) {
      this.requestStream = undefined;
      this.switchedView.resolve();
    }
    this.stream = stream;
    for (const part of this.parts) {
      this.send(part);
    }
    if (this.finished) {
      this.stream = undefined;
      return;
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

  public stop(): void {
    if (!this.finished && !this.stopToken.isCancellationRequested) {
      this.stopSource.cancel();
      this.switchedView.resolve();
      this.stopPrompt();
    }
  }

  public stopRequestStream(stream: vscode.ChatResponseStream): void {
    if (this.requestStream === stream) {
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
}
