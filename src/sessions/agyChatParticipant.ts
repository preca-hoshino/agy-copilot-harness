import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  AcpContentBlock,
  AcpRequestPermissionParams,
  AcpSessionPromptResult,
  AcpSessionUpdate,
  AcpToolCallUpdatePayload,
} from '../acp/acpTypes.js';
import type { AgyLanguageModelProvider } from '../models/agyLanguageModelProvider.js';
import type { AcpBackendInterface, PermissionPrompt, QuotaServiceInterface } from '../shared/contracts.js';
import { ActiveAgyTurn } from './activeAgyTurn.js';
import { isSkillMarkdownPath, resolveSkillDisplayNameSync } from './agyCustomizationProvider.js';
import { AgyEditTracker } from './agyEditTracker.js';
import type { AgySessionController } from './agySessionController.js';
import { extractSessionIdFromUri } from './agySessionController.js';
import type { BrowserSubagentRenderer } from './browserSubagentRenderer.js';
import { acquireSessionOperation } from './sessionOperationCoordinator.js';
import { LiveStreamAdapter } from './turnConverter.js';

interface SyncedSessionConfig {
  readonly model: string;
  readonly thoughtLevel: string;
  readonly mode: string;
}

interface BinaryReferenceLike {
  readonly mimeType: string;
  readonly data: (() => Thenable<Uint8Array>) | Uint8Array;
  readonly reference?: unknown;
}

interface UriLike {
  readonly scheme: string;
  readonly fsPath: string;
  readonly path: string;
  toString: () => string;
}

interface PositionLike {
  readonly line: number;
  readonly character: number;
}

interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

interface LocationLike {
  readonly uri: UriLike;
  readonly range: RangeLike;
}

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

const MAX_TITLE_LENGTH = 60;
const LIVE_UPDATE_QUIET_MS = 250;
const LIVE_UPDATE_MAX_DRAIN_MS = 10_000;
const MAX_HANDOFF_BUFFER = 500;
const YIELD_PERMISSION_DELEGATE_TIMEOUT_MS = 500;
const YIELD_POLL_INTERVAL_MS = 100;
const CANCELLING_RETRY_DELAYS_MS: readonly number[] = [100, 200, 350, 500, 750, 1000, 1000, 1500, 2000, 2500];

type TurnPhase = 'prompt' | 'idle-wait' | 'draining' | 'yielded' | 'finished';

interface SupersededTurnHandoff {
  readonly bufferedUpdates: readonly AcpSessionUpdate[];
  readonly toolCalls: ReadonlyMap<string, AcpToolCallUpdatePayload>;
}

class RunningTurnState {
  public readonly idleWaitCts = new vscode.CancellationTokenSource();
  public readonly settled: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  private readonly stateChanged = new vscode.EventEmitter<void>();
  private readonly handoffBuffer: AcpSessionUpdate[] = [];
  private readonly yieldedPermissionResolvers: Array<(delegate: PermissionPrompt | undefined) => void> = [];

  private phase: TurnPhase = 'prompt';
  private superseded = false;
  private pendingPermissions = 0;
  private needsInput = false;
  private disconnected: Error | undefined;
  private detachHandlers: (() => void) | undefined;
  private stateDisposed = false;

  public constructor(
    public readonly sessionId: string,
    public readonly turn: ActiveAgyTurn,
    public readonly liveAdapter: LiveStreamAdapter,
    public readonly userPrompt: string,
  ) {}

  public isTurnSuperseded(): boolean {
    return this.superseded;
  }

  public isTurnCancelling(): boolean {
    return this.turn.stopToken.isCancellationRequested;
  }

  public isTurnYielded(): boolean {
    return this.phase === 'yielded';
  }

  public isTurnFinished(): boolean {
    return this.phase === 'finished';
  }

  public hasTurnNeedsInput(): boolean {
    return this.needsInput;
  }

  public getDisconnectError(): Error | undefined {
    return this.disconnected;
  }

  public setPhase(next: TurnPhase): void {
    if (this.phase !== 'finished' && !this.superseded) {
      this.phase = next;
    }
  }

  public incrementPermissions(): void {
    this.pendingPermissions += 1;
    this.notifyStateChanged();
  }

  public decrementPermissions(): number {
    this.pendingPermissions = Math.max(0, this.pendingPermissions - 1);
    this.notifyStateChanged();
    return this.pendingPermissions;
  }

  public markNeedsInput(): void {
    this.needsInput = true;
    this.notifyStateChanged();
  }

  public markDisconnected(error: Error): void {
    this.disconnected = error;
    this.notifyStateChanged();
  }

  public bufferUpdate(update: AcpSessionUpdate): void {
    if (this.handoffBuffer.length >= MAX_HANDOFF_BUFFER) {
      this.handoffBuffer.shift();
    }
    this.handoffBuffer.push(update);
  }

  public setDetachHandlers(detach: () => void): void {
    this.detachHandlers = detach;
  }

  public canBeSuperseded(): boolean {
    return (
      !this.superseded &&
      !this.isTurnCancelling() &&
      this.pendingPermissions === 0 &&
      !this.needsInput &&
      this.phase !== 'finished'
    );
  }

  public notifyStateChanged(): void {
    if (!this.stateDisposed) {
      this.stateChanged.fire();
    }
  }

  public async waitUntilSteerableOrSettled(token: vscode.CancellationToken): Promise<void> {
    if (this.phase === 'finished' || this.superseded || this.canBeSuperseded()) {
      return;
    }
    if (isTokenCancelled(token)) {
      throw createCancellationError();
    }
    let stateSub: vscode.Disposable | undefined;
    let cancelSub: vscode.Disposable | undefined;
    try {
      await Promise.race([
        this.settled.promise,
        new Promise<void>((resolve) => {
          stateSub = this.stateChanged.event(() => {
            if (this.phase === 'finished' || this.superseded || this.canBeSuperseded()) {
              resolve();
            }
          });
        }),
        ...(typeof token.onCancellationRequested === 'function'
          ? [
              new Promise<never>((_, reject) => {
                cancelSub = token.onCancellationRequested(() => {
                  reject(createCancellationError());
                });
              }),
            ]
          : []),
      ]);
    } finally {
      stateSub?.dispose();
      cancelSub?.dispose();
    }
  }

  public yieldToSteering(detachCancelSubscription: () => void): void {
    if (this.phase === 'finished' || this.phase === 'yielded' || this.superseded) {
      return;
    }
    this.phase = 'yielded';
    detachCancelSubscription();
    if (!this.idleWaitCts.token.isCancellationRequested) {
      this.idleWaitCts.cancel();
    }
    this.liveAdapter.flush({ preserveBrowserSession: true });
    this.notifyStateChanged();
  }

  public async waitForSuccessorPermission(timeoutMs: number): Promise<PermissionPrompt | undefined> {
    if (this.phase !== 'yielded' || this.superseded) {
      return undefined;
    }
    return await new Promise<PermissionPrompt | undefined>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (delegate: PermissionPrompt | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        const idx = this.yieldedPermissionResolvers.indexOf(finish);
        if (idx !== -1) {
          this.yieldedPermissionResolvers.splice(idx, 1);
        }
        resolve(delegate);
      };
      this.yieldedPermissionResolvers.push(finish);
      timer = setTimeout(() => {
        finish(undefined);
      }, timeoutMs);
    });
  }

  public supersede(delegatePermission?: PermissionPrompt): SupersededTurnHandoff {
    this.superseded = true;
    this.phase = 'finished';
    this.resolveYieldedPermissions(delegatePermission);
    this.runDetachHandlers();
    if (!this.idleWaitCts.token.isCancellationRequested) {
      this.idleWaitCts.cancel();
    }
    this.idleWaitCts.dispose();
    this.liveAdapter.flush({ preserveBrowserSession: true });
    this.turn.finish();
    this.notifyStateChanged();
    this.disposeStateChanged();
    return {
      bufferedUpdates: [...this.handoffBuffer],
      toolCalls: this.liveAdapter.getToolCallsSnapshot(),
    };
  }

  public finalize(): void {
    this.phase = 'finished';
    this.resolveYieldedPermissions(undefined);
    this.runDetachHandlers();
    if (!this.idleWaitCts.token.isCancellationRequested) {
      this.idleWaitCts.cancel();
    }
    this.idleWaitCts.dispose();
    this.notifyStateChanged();
    this.disposeStateChanged();
    this.settled.resolve();
  }

  private resolveYieldedPermissions(delegate: PermissionPrompt | undefined): void {
    const resolvers = this.yieldedPermissionResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(delegate);
    }
  }

  private runDetachHandlers(): void {
    const detach = this.detachHandlers;
    this.detachHandlers = undefined;
    detach?.();
  }

  private disposeStateChanged(): void {
    if (!this.stateDisposed) {
      this.stateDisposed = true;
      this.stateChanged.dispose();
    }
  }
}

export interface ActiveAgySession {
  readonly history: vscode.ChatSession['history'];
  readonly activeResponseCallback: NonNullable<vscode.ChatSession['activeResponseCallback']>;
}

export class AgyChatParticipant implements vscode.Disposable {
  private readonly backend: AcpBackendInterface;
  private readonly controller: AgySessionController;
  private readonly lmProvider: AgyLanguageModelProvider;
  private readonly quotaService: QuotaServiceInterface;
  private readonly browserRenderer: BrowserSubagentRenderer;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly setSessionModeHook: ((sessionId: string, mode: string) => void) | undefined;

  private readonly syncedConfigs = new Map<string, SyncedSessionConfig>();
  private readonly activeDisposables = new Set<vscode.Disposable>();
  private readonly activeTurns = new Map<string, ActiveAgyTurn>();
  private readonly runningTurns = new Map<string, RunningTurnState>();
  private readonly pendingCreations = new Map<string, Promise<string>>();
  private disposed = false;

  public constructor(
    backend: AcpBackendInterface,
    controller: AgySessionController,
    lmProvider: AgyLanguageModelProvider,
    quotaService: QuotaServiceInterface,
    browserRenderer: BrowserSubagentRenderer,
    outputChannel: vscode.OutputChannel,
    setSessionModeHook?: (sessionId: string, mode: string) => void,
    private readonly attachmentDir?: string,
  ) {
    this.backend = backend;
    this.controller = controller;
    this.lmProvider = lmProvider;
    this.quotaService = quotaService;
    this.browserRenderer = browserRenderer;
    this.outputChannel = outputChannel;
    this.setSessionModeHook = setSessionModeHook;
    this.controller.registerActiveTurnSnapshotProvider((sessionId) => this.getActiveTurnSnapshot(sessionId));
  }

  private getActiveTurnSnapshot(
    sessionId: string,
  ): { readonly userPrompt: string; readonly assistantPartialResponse: string } | undefined {
    const running = this.runningTurns.get(sessionId);
    if (running === undefined || running.isTurnFinished()) {
      return undefined;
    }
    return {
      userPrompt: running.userPrompt,
      assistantPartialResponse: running.liveAdapter.getAccumulatedMessageText(),
    };
  }

  public createHandler(): vscode.ChatRequestHandler {
    return async (
      request: vscode.ChatRequest,
      context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> => {
      return await this.handleRequest(request, context, stream, token);
    };
  }

  public getActiveSession(sessionId: string): ActiveAgySession | undefined {
    const turn = this.activeTurns.get(sessionId);
    return turn === undefined ? undefined : { history: turn.history, activeResponseCallback: turn.attach };
  }

  public dispose(): void {
    this.disposed = true;
    for (const running of this.runningTurns.values()) {
      running.finalize();
    }
    this.runningTurns.clear();
    this.pendingCreations.clear();
    for (const turn of this.activeTurns.values()) {
      turn.finish();
    }
    this.activeTurns.clear();
    for (const disposable of this.activeDisposables) {
      disposable.dispose();
    }
    this.activeDisposables.clear();
    this.syncedConfigs.clear();
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    if (this.isDisposed()) {
      return {};
    }

    const sessionItem = context.chatSessionContext?.chatSessionItem;
    const rawSessionId =
      sessionItem !== undefined ? extractSessionIdFromUri(sessionItem.resource) : `untitled-${crypto.randomUUID()}`;

    if (context.chatSessionContext !== undefined && this.controller.isNewSession(rawSessionId)) {
      this.applyContextInitialOptions(rawSessionId, context.chatSessionContext);
    }

    let sessionId = this.controller.resolveSessionId(rawSessionId);

    let activeTurn: ActiveAgyTurn | undefined;
    let releaseSession: (() => void) | undefined;
    try {
      const cwd = await this.controller.getSessionCwd(rawSessionId);
      if (!this.backend.isReady) {
        await this.backend.ensureStarted();
      }

      if (this.controller.isNewSession(rawSessionId)) {
        const realized = await this.realizeNewSession(rawSessionId, cwd, request.prompt, token);
        sessionId = realized.sessionId;
        releaseSession = realized.releaseSession;
      }

      const sideChatPreamble = this.controller.consumeSideChatPreamble(sessionId);
      const contentBlocks = await buildPromptBlocks(request, this.outputChannel, sideChatPreamble);
      if (isTokenCancelled(token)) {
        if (!this.runningTurns.has(sessionId)) {
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
        }
        return {};
      }

      let predecessor: RunningTurnState | undefined;
      for (;;) {
        if (this.isDisposed() || isTokenCancelled(token)) {
          return {};
        }
        const existing = this.runningTurns.get(sessionId);
        if (existing !== undefined && !existing.canBeSuperseded()) {
          if (releaseSession !== undefined) {
            releaseSession();
            releaseSession = undefined;
          }
          await existing.waitUntilSteerableOrSettled(token);
          continue;
        }
        releaseSession ??= await acquireSessionOperation(this.backend, sessionId, token);
        const current = this.runningTurns.get(sessionId);
        if (current !== undefined && !current.canBeSuperseded()) {
          releaseSession();
          releaseSession = undefined;
          continue;
        }
        predecessor = current;
        break;
      }

      const effectiveMode = request.command === 'plan' ? 'plan' : this.controller.getSessionMode(sessionId);

      const selectedModelId = getModelIdSafely(request.model);
      const resolvedModel = this.lmProvider.resolveModelAndEffort(selectedModelId, request.modelConfiguration);
      const previousConfig = this.syncedConfigs.get(sessionId);
      const isFirstTurn = previousConfig === undefined;

      if (resolvedModel.modelValue.length > 0 && (isFirstTurn || previousConfig.model !== resolvedModel.modelValue)) {
        await this.safeSetConfigOption(sessionId, 'model', resolvedModel.modelValue);
      }

      if (
        resolvedModel.thoughtLevel.length > 0 &&
        (isFirstTurn || previousConfig.thoughtLevel !== resolvedModel.thoughtLevel)
      ) {
        await this.safeSetConfigOption(sessionId, 'thought_level', resolvedModel.thoughtLevel);
      }

      if (effectiveMode.length > 0 && (isFirstTurn || previousConfig.mode !== effectiveMode)) {
        const options = await this.backend.setConfigOption(sessionId, 'mode', effectiveMode);
        const mode = options?.find((option) => option.id === 'mode')?.currentValue ?? effectiveMode;
        this.controller.setSessionMode(sessionId, mode);
      }

      this.syncedConfigs.set(sessionId, {
        model: resolvedModel.modelValue,
        thoughtLevel: resolvedModel.thoughtLevel,
        mode: this.controller.getSessionMode(sessionId),
      });

      if (this.isDisposed() || isTokenCancelled(token)) {
        if (!this.runningTurns.has(sessionId)) {
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
        }
        return {};
      }

      const history = [...context.history, createRequestTurn(request)];
      const turn = new ActiveAgyTurn(history, stream, () => {
        void this.backend.cancel(sessionId).catch((cancelError: unknown) => {
          this.outputChannel.appendLine(
            `[AgyChatParticipant] Failed to cancel session ${sessionId}: ${formatError(cancelError)}`,
          );
        });
      });

      const configuredAppDataDir = vscode.workspace
        .getConfiguration('antigravityHarness')
        .get<string>('appDataDir')
        ?.trim();
      const editTracker = new AgyEditTracker({
        sessionId,
        sessionCwd: cwd,
        ...(configuredAppDataDir !== undefined && configuredAppDataDir.length > 0
          ? { appDataDir: configuredAppDataDir }
          : {}),
        backend: this.backend,
        startExternalEdit: async (uri, write, onTracked): Promise<void> => {
          await turn.externalEdit(uri, write, onTracked);
        },
        outputChannel: this.outputChannel,
      });

      let runningRef: RunningTurnState | undefined;
      const liveAdapter = new LiveStreamAdapter(
        this.browserRenderer,
        sessionId,
        turn,
        (change: vscode.ChatSessionFileChange): void => {
          this.controller.recordFileChange(sessionId, change);
        },
        (reason: string): void => {
          runningRef?.markNeedsInput();
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.NeedsInput);
          this.outputChannel.appendLine(`[AgyChatParticipant] Session ${sessionId} needs input: ${reason}`);
        },
        this.attachmentDir,
        (usage): void => {
          if (typeof usage.size === 'number' && Number.isFinite(usage.size) && usage.size > 0) {
            this.lmProvider.recordContextWindow(selectedModelId ?? resolvedModel.modelValue, usage.size);
          }
        },
        editTracker,
      );
      const running = new RunningTurnState(sessionId, turn, liveAdapter, request.prompt);
      runningRef = running;

      let resetDrainTimer: (() => void) | undefined;
      let rejectDrain: ((error: Error) => void) | undefined;
      let yieldPollTimer: ReturnType<typeof setInterval> | undefined;
      let promptDispatched = false;
      const yielded = Promise.withResolvers<void>();

      const stopYieldPolling = (): void => {
        if (yieldPollTimer !== undefined) {
          clearInterval(yieldPollTimer);
          yieldPollTimer = undefined;
        }
      };

      const permissionHandler: PermissionPrompt = async (permission): Promise<string | undefined> => {
        if (running.isTurnSuperseded() || running.isTurnFinished()) {
          return undefined;
        }
        if (running.isTurnYielded()) {
          const delegate = await running.waitForSuccessorPermission(YIELD_PERMISSION_DELEGATE_TIMEOUT_MS);
          if (delegate !== undefined) {
            return await delegate(permission);
          }
          if (running.isTurnSuperseded() || running.isTurnFinished()) {
            return undefined;
          }
        }
        running.incrementPermissions();
        this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.NeedsInput);
        try {
          return await askTurnPermission(turn, permission, request.toolInvocationToken, this.outputChannel);
        } catch (error: unknown) {
          this.outputChannel.appendLine(`[AgyChatParticipant] Permission prompt failed: ${formatError(error)}`);
          return undefined;
        } finally {
          const remaining = running.decrementPermissions();
          if (
            remaining === 0 &&
            !running.isTurnSuperseded() &&
            !running.hasTurnNeedsInput() &&
            !isTokenCancelled(turn.stopToken) &&
            this.backend.isReady
          ) {
            this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.InProgress);
          }
          maybeYield();
        }
      };

      let cancelSubscription: vscode.Disposable | undefined;
      const maybeYield = (): void => {
        if (
          !promptDispatched ||
          context.yieldRequested !== true ||
          !running.canBeSuperseded() ||
          running.getDisconnectError() !== undefined ||
          !this.backend.isReady
        ) {
          return;
        }
        stopYieldPolling();
        running.yieldToSteering(() => {
          if (cancelSubscription !== undefined) {
            cancelSubscription.dispose();
            this.activeDisposables.delete(cancelSubscription);
            cancelSubscription = undefined;
          }
        });
        yielded.resolve();
      };

      const handoff =
        predecessor !== undefined && !predecessor.isTurnFinished()
          ? predecessor.supersede(permissionHandler)
          : undefined;
      if (handoff !== undefined) {
        liveAdapter.seedToolCalls(handoff.toolCalls);
      }

      activeTurn = turn;
      this.activeTurns.set(sessionId, turn);
      this.runningTurns.set(sessionId, running);
      // Once published, a history provider can reattach instead of replaying. Release
      // the preparation lock so callers already queued behind it can do that too.
      releaseSession();
      releaseSession = undefined;
      this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.InProgress);

      const backendSubscription = this.backend.onDidChangeBackendState((event) => {
        if (!event.ready) {
          const error = new Error('ACP backend disconnected while running the conversation.');
          running.markDisconnected(error);
          rejectDrain?.(error);
        }
      });
      const updateSubscription = this.backend.onDidChangeUpdate((event) => {
        if (event.sessionId !== sessionId || running.getDisconnectError() !== undefined || running.isTurnSuperseded()) {
          return;
        }
        resetDrainTimer?.();
        if (
          event.update.sessionUpdate === 'current_mode_update' &&
          'currentModeId' in event.update &&
          typeof event.update.currentModeId === 'string'
        ) {
          this.controller.setSessionMode(sessionId, event.update.currentModeId);
          this.setSessionModeHook?.(sessionId, event.update.currentModeId);
        }
        if (running.isTurnYielded()) {
          running.bufferUpdate(event.update);
        } else {
          liveAdapter.handleUpdate(event.update);
        }
        maybeYield();
      });

      const permissionSubscription = this.backend.registerPermissionPrompt?.(sessionId, permissionHandler);

      const fileWriteSubscription = this.backend.registerFileWriteHandler?.(sessionId, async (uri, write) => {
        if (!editTracker.shouldTrackInWorkingSet(uri.fsPath)) {
          await write();
          return;
        }
        editTracker.markFileWriteHandled(uri);
        await turn.externalEdit(uri, write, () => {
          liveAdapter.markExternalEdit(uri);
        });
      });

      cancelSubscription = token.onCancellationRequested(() => {
        turn.stopRequestStream(stream);
      });
      const stopSubscription = turn.stopToken.onCancellationRequested(() => {
        if (!running.idleWaitCts.token.isCancellationRequested) {
          running.idleWaitCts.cancel();
        }
        running.notifyStateChanged();
      });

      const turnDisposables: vscode.Disposable[] = [
        backendSubscription,
        updateSubscription,
        cancelSubscription,
        stopSubscription,
      ];
      if (permissionSubscription !== undefined) {
        turnDisposables.push(permissionSubscription);
      }
      if (fileWriteSubscription !== undefined) {
        turnDisposables.push(fileWriteSubscription);
      }
      for (const disposable of turnDisposables) {
        this.activeDisposables.add(disposable);
      }

      let handlersDetached = false;
      const detachHandlers = (): void => {
        if (handlersDetached) {
          return;
        }
        handlersDetached = true;
        stopYieldPolling();
        for (const disposable of turnDisposables) {
          disposable.dispose();
          this.activeDisposables.delete(disposable);
        }
      };
      running.setDetachHandlers(detachHandlers);

      if (handoff !== undefined) {
        for (const bufferedUpdate of handoff.bufferedUpdates) {
          liveAdapter.handleUpdate(bufferedUpdate);
        }
      }

      if ('yieldRequested' in context) {
        yieldPollTimer = setInterval(maybeYield, YIELD_POLL_INTERVAL_MS);
      }

      const runTurnLifecycle = async (): Promise<vscode.ChatResult> => {
        try {
          const promptResult = await this.sendPromptWithTransientRetry(sessionId, contentBlocks, running, () => {
            promptDispatched = true;
          });
          if (running.isTurnSuperseded()) {
            return { metadata: { sessionId, superseded: true } };
          }
          if (
            !turn.stopToken.isCancellationRequested &&
            promptResult.stopReason !== 'cancelled' &&
            !running.isTurnYielded()
          ) {
            const promptDisconnect = running.getDisconnectError();
            if (promptDisconnect !== undefined) {
              throw promptDisconnect;
            }
            running.setPhase('idle-wait');
            await this.backend.waitForConversationFullyIdle(sessionId, running.idleWaitCts.token);
            if (running.isTurnSuperseded()) {
              return { metadata: { sessionId, superseded: true } };
            }
            const idleDisconnect = running.getDisconnectError();
            if (idleDisconnect !== undefined) {
              throw idleDisconnect;
            }
            if (!running.isTurnYielded()) {
              running.setPhase('draining');
              await new Promise<void>((resolve, reject) => {
                let quietTimer: ReturnType<typeof setTimeout> | undefined;
                let cancellation: vscode.Disposable | undefined;
                const cleanup = (): void => {
                  clearTimeout(quietTimer);
                  clearTimeout(maximumTimer);
                  cancellation?.dispose();
                  resetDrainTimer = undefined;
                  rejectDrain = undefined;
                };
                const finish = (): void => {
                  cleanup();
                  resolve();
                };
                const fail = (error: Error): void => {
                  cleanup();
                  reject(error);
                };
                const maximumTimer = setTimeout(() => {
                  fail(new Error('Timed out draining conversation updates after the backend became idle.'));
                }, LIVE_UPDATE_MAX_DRAIN_MS);
                rejectDrain = fail;
                cancellation = running.idleWaitCts.token.onCancellationRequested(() => {
                  fail(createCancellationError());
                });
                resetDrainTimer = (): void => {
                  clearTimeout(quietTimer);
                  quietTimer = setTimeout(finish, LIVE_UPDATE_QUIET_MS);
                };
                if (running.idleWaitCts.token.isCancellationRequested) {
                  fail(createCancellationError());
                } else {
                  resetDrainTimer();
                }
              });
              if (running.isTurnSuperseded()) {
                return { metadata: { sessionId, superseded: true } };
              }
              const drainDisconnect = running.getDisconnectError();
              if (drainDisconnect !== undefined || !this.backend.isReady) {
                throw drainDisconnect ?? new Error('ACP backend disconnected while draining conversation updates.');
              }
            }
          }
          if (!running.isTurnSuperseded() && (!running.hasTurnNeedsInput() || turn.stopToken.isCancellationRequested)) {
            this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
          }

          const metadata: Record<string, unknown> = {
            sessionId,
            ...(promptResult.stopReason !== undefined ? { stopReason: promptResult.stopReason } : {}),
          };
          return { metadata };
        } catch (error: unknown) {
          if (running.isTurnSuperseded()) {
            return { metadata: { sessionId, superseded: true } };
          }
          if (
            running.isTurnYielded() &&
            running.idleWaitCts.token.isCancellationRequested &&
            !turn.stopToken.isCancellationRequested &&
            running.getDisconnectError() === undefined
          ) {
            const currentOwner = this.runningTurns.get(sessionId);
            if (currentOwner === undefined || currentOwner === running) {
              this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
            }
            return { metadata: { sessionId, yielded: true } };
          }
          if (turn.stopToken.isCancellationRequested && !isAuthenticationRequiredError(error)) {
            this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
            return {};
          }

          const errorMessage = formatError(error);
          this.outputChannel.appendLine(`[AgyChatParticipant] Turn failed for session ${sessionId}: ${errorMessage}`);
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Failed);

          if (isAuthenticationRequiredError(error)) {
            turn.push(
              new vscode.ChatResponseMarkdownPart(
                'Antigravity authentication is required. Please sign in with your Google account to continue.\n\n',
              ),
            );
            turn.push(
              new vscode.ChatResponseCommandButtonPart({
                title: 'Sign In with Google',
                command: 'antigravityHarness.signIn',
              }),
            );
          }

          return {
            errorDetails: {
              message: errorMessage,
            },
          };
        } finally {
          stopYieldPolling();
          const superseded = running.isTurnSuperseded();
          if (!superseded) {
            try {
              await editTracker.flush();
              liveAdapter.flush();
              this.controller.recordTurnContext(sessionId, request.prompt, liveAdapter.getAccumulatedMessageText());
            } finally {
              turn.finish();
              if (this.activeTurns.get(sessionId) === turn) {
                this.activeTurns.delete(sessionId);
              }
              if (this.runningTurns.get(sessionId) === running) {
                this.runningTurns.delete(sessionId);
              }
              running.finalize();
            }
            try {
              await this.quotaService.refresh(true);
            } catch (refreshError: unknown) {
              this.outputChannel.appendLine(
                `[AgyChatParticipant] Quota refresh failed after turn: ${formatError(refreshError)}`,
              );
            }
          } else {
            if (this.activeTurns.get(sessionId) === turn) {
              this.activeTurns.delete(sessionId);
            }
            if (this.runningTurns.get(sessionId) === running) {
              this.runningTurns.delete(sessionId);
            }
            running.settled.resolve();
          }
        }
      };

      const lifecyclePromise = runTurnLifecycle();
      void lifecyclePromise.catch(() => {
        /* errors are converted to ChatResult inside runTurnLifecycle */
      });
      const outcome = await Promise.race([
        lifecyclePromise.then((result) => ({ kind: 'done' as const, result })),
        yielded.promise.then(() => ({ kind: 'yielded' as const })),
      ]);
      if (outcome.kind === 'yielded') {
        return { metadata: { sessionId, yielded: true } };
      }
      return outcome.result;
    } catch (error: unknown) {
      if (
        (activeTurn?.stopToken.isCancellationRequested ?? isTokenCancelled(token)) &&
        !isAuthenticationRequiredError(error)
      ) {
        if (activeTurn !== undefined) {
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
        }
        return {};
      }

      const errorMessage = formatError(error);
      this.outputChannel.appendLine(`[AgyChatParticipant] Turn failed for session ${sessionId}: ${errorMessage}`);
      if (activeTurn !== undefined || !this.runningTurns.has(sessionId)) {
        this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Failed);
      }

      if (isAuthenticationRequiredError(error)) {
        const response = activeTurn ?? stream;
        response.push(
          new vscode.ChatResponseMarkdownPart(
            'Antigravity authentication is required. Please sign in with your Google account to continue.\n\n',
          ),
        );
        response.push(
          new vscode.ChatResponseCommandButtonPart({
            title: 'Sign In with Google',
            command: 'antigravityHarness.signIn',
          }),
        );
      }

      return {
        errorDetails: {
          message: errorMessage,
        },
      };
    } finally {
      releaseSession?.();
    }
  }

  private async realizeNewSession(
    rawSessionId: string,
    cwd: string,
    promptText: string,
    token: vscode.CancellationToken,
  ): Promise<{ readonly sessionId: string; readonly releaseSession?: (() => void) | undefined }> {
    const existingCreation = this.pendingCreations.get(rawSessionId);
    if (existingCreation !== undefined) {
      return { sessionId: await existingCreation };
    }
    let acquiredRelease: (() => void) | undefined;
    const creation = (async (): Promise<string> => {
      const created = await this.backend.newSession(cwd);
      const newSessionId = created.sessionId;
      // Hold the per-session operation lock before publishing the realized item so
      // an eager session open attaches to the active turn rather than replaying.
      acquiredRelease = await acquireSessionOperation(this.backend, newSessionId, token);
      try {
        this.controller.markSessionRealized(rawSessionId, newSessionId);
        const derivedTitle = deriveSessionTitle(promptText);
        this.controller.updateSessionMetadata(newSessionId, {
          ...(derivedTitle !== undefined ? { title: derivedTitle } : {}),
        });
        return newSessionId;
      } catch (error: unknown) {
        acquiredRelease();
        acquiredRelease = undefined;
        throw error;
      }
    })();
    this.pendingCreations.set(rawSessionId, creation);
    try {
      const newSessionId = await creation;
      const releaseSession = acquiredRelease;
      acquiredRelease = undefined;
      return { sessionId: newSessionId, ...(releaseSession !== undefined ? { releaseSession } : {}) };
    } finally {
      acquiredRelease?.();
      if (this.pendingCreations.get(rawSessionId) === creation) {
        this.pendingCreations.delete(rawSessionId);
      }
    }
  }

  private async sendPromptWithTransientRetry(
    sessionId: string,
    contentBlocks: AcpContentBlock[],
    running: RunningTurnState,
    onDispatched: () => void,
  ): Promise<AcpSessionPromptResult> {
    for (let attempt = 0; ; attempt += 1) {
      onDispatched();
      try {
        return await this.backend.prompt(sessionId, contentBlocks, running.turn.stopToken);
      } catch (error: unknown) {
        const retryDelayMs = CANCELLING_RETRY_DELAYS_MS[attempt];
        if (
          retryDelayMs === undefined ||
          !isCancellingPromptRetryableError(error) ||
          running.isTurnSuperseded() ||
          running.turn.stopToken.isCancellationRequested ||
          !this.backend.isReady
        ) {
          throw error;
        }
        this.outputChannel.appendLine(
          `[AgyChatParticipant] Backend still cancelling previous prompt for session ${sessionId}; retrying in ${retryDelayMs}ms`,
        );
        await waitWithCancellation(retryDelayMs, running.turn.stopToken);
      }
    }
  }

  private async safeSetConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    try {
      await this.backend.setConfigOption(sessionId, configId, value);
    } catch (error: unknown) {
      if (isAuthenticationRequiredError(error)) {
        throw error;
      }
      this.outputChannel.appendLine(
        `[AgyChatParticipant] Failed to set config option ${configId}=${value} for ${sessionId}: ${formatError(error)}`,
      );
    }
  }

  private applyContextInitialOptions(sessionId: string, chatSessionContext: vscode.ChatSessionContext): void {
    const contextRecord = extractObjectProperty(chatSessionContext, 'inputState');
    if (contextRecord === undefined) {
      return;
    }

    const groupsProp = extractObjectProperty(contextRecord, 'groups');
    if (!Array.isArray(groupsProp)) {
      return;
    }

    for (const group of groupsProp) {
      if (!isRecordObject(group)) {
        continue;
      }
      const groupId = typeof group.id === 'string' ? group.id : undefined;
      const selected = isRecordObject(group.selected) ? group.selected : undefined;
      const selectedId = selected !== undefined && typeof selected.id === 'string' ? selected.id : undefined;
      if (groupId === 'mode' && selectedId !== undefined && selectedId.length > 0) {
        this.controller.setSessionMode(sessionId, selectedId);
      }
    }
  }
}

function createRequestTurn(request: vscode.ChatRequest): vscode.ChatRequestTurn {
  const references = request.references.filter((reference) => reference.id !== 'vscode.customizations.index');
  // Both API names refer to the same runtime constructor; the stable declaration has a private constructor.
  const requestTurnConstructor = vscode.ChatRequestTurn2 as new (
    ...args: ConstructorParameters<typeof vscode.ChatRequestTurn2>
  ) => vscode.ChatRequestTurn;
  return new requestTurnConstructor(
    request.prompt,
    request.command,
    references,
    'antigravity',
    request.toolReferences,
    undefined,
    undefined,
    getModelIdSafely(request.model),
  );
}

async function askTurnPermission(
  turn: ActiveAgyTurn,
  permission: AcpRequestPermissionParams,
  toolInvocationToken: unknown,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const tool = permission.toolCall;
  const fields = tool.rawInput ?? {};
  const command = fields.CommandLine ?? fields.commandLine ?? fields.command ?? fields.cmd ?? fields.script;
  const cwd = fields.Cwd ?? fields.cwd ?? fields.WorkingDirectory;
  const isTerminal =
    tool.kind === 'execute' || /^(run_command|execute_command|bash|sh|pwsh|powershell|terminal)$/.test(tool.name ?? '');
  const title = tool.title ?? tool.name ?? tool.toolCallId;
  const message = new vscode.MarkdownString();
  if (typeof command === 'string') {
    message.appendCodeblock(command, 'shell');
  } else {
    message.appendText(title);
  }
  if (typeof cwd === 'string') {
    message.appendText(`\nWorking directory: ${cwd}`);
  }

  if (
    toolInvocationToken !== undefined &&
    typeof (vscode.lm as { invokeTool?: unknown } | undefined)?.invokeTool === 'function'
  ) {
    const isTerminalCommand = isTerminal && typeof command === 'string' && command.trim().length > 0;
    const toolName = isTerminalCommand ? 'vscode_get_terminal_confirmation' : 'vscode_get_confirmation';
    const explanation =
      typeof cwd === 'string' && cwd.trim().length > 0
        ? `Working directory: ${cwd}`
        : title !== command
          ? title
          : 'Execute command in terminal';
    const input = isTerminalCommand
      ? {
          command,
          message: explanation,
          explanation,
          goal: title.length > 0 ? title : 'Run terminal command',
          mode: 'sync',
          isBackground: false,
        }
      : {
          title: title.length > 0 ? title : 'Antigravity Permission Request',
          message: message.value.trim().length > 0 ? message.value : title,
          confirmationType: 'basic',
        };

    try {
      const result = await vscode.lm.invokeTool(
        toolName,
        { input, toolInvocationToken: toolInvocationToken as vscode.ChatParticipantToolToken },
        turn.stopToken,
      );
      const responseText = extractToolResultText(result.content);
      return responseText?.trim().toLowerCase() === 'yes'
        ? pickApproveOptionId(permission.options)
        : pickRejectOptionId(permission.options);
    } catch (error: unknown) {
      if (turn.stopToken.isCancellationRequested) {
        return undefined;
      }
      if (isToolUnavailableError(error)) {
        outputChannel.appendLine(
          `[AgyChatParticipant] Built-in confirmation tool "${toolName}" unavailable, falling back: ${formatError(error)}`,
        );
      } else if (isCancellationError(error)) {
        return pickRejectOptionId(permission.options);
      } else {
        outputChannel.appendLine(`[AgyChatParticipant] Confirmation tool "${toolName}" failed: ${formatError(error)}`);
        return pickRejectOptionId(permission.options);
      }
    }
  }

  const requestId = crypto.randomUUID();
  const id =
    isTerminal && typeof command === 'string' && command.trim().length > 0
      ? `agy-terminal:${JSON.stringify({
          requestId,
          command,
          cwd: typeof cwd === 'string' ? cwd : undefined,
          options: permission.options.map(({ optionId, kind }) => ({ optionId, kind })),
        })}`
      : requestId;

  const stream = turn.permissionStream;
  if (typeof stream?.questionCarousel === 'function') {
    const answers = await Promise.race([
      askInChat(stream, [
        {
          id,
          type: vscode.ChatQuestionType.SingleSelect,
          title: 'Antigravity: Approve tool execution?',
          message,
          options: permission.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            value: option.optionId,
          })),
          defaultValue: permission.options.find((option) => option.kind === 'reject_once')?.optionId ?? '',
        },
      ]),
      turn.onViewSwitched.then(() => undefined),
    ]);
    if (answers !== undefined && turn.permissionStream === stream) {
      const choice = answers[id];
      return typeof choice === 'string' ? choice : undefined;
    }
  }

  if (turn.stopToken.isCancellationRequested) {
    return undefined;
  }
  // Restored chat streams cannot answer the original request's carousel; require a fresh, explicit choice.
  const picked = await vscode.window.showQuickPick(
    permission.options.map((option) => ({
      label: option.name,
      description: option.kind,
      detail: typeof command === 'string' ? command : title,
      optionId: option.optionId,
    })),
    {
      placeHolder: `Antigravity permission request: ${title}`,
      ignoreFocusOut: true,
    },
    turn.stopToken,
  );
  return isTokenCancelled(turn.stopToken) ? undefined : picked?.optionId;
}

function pickApproveOptionId(options: readonly AcpRequestPermissionParams['options'][number][]): string | undefined {
  return (
    options.find((option) => option.kind === 'allow_once')?.optionId ??
    options.find((option) => option.kind.startsWith('allow_'))?.optionId
  );
}

function pickRejectOptionId(options: readonly AcpRequestPermissionParams['options'][number][]): string | undefined {
  return (
    options.find((option) => option.kind === 'reject_once')?.optionId ??
    options.find((option) => option.kind.startsWith('reject_'))?.optionId
  );
}

function extractToolResultText(content: readonly unknown[]): string | undefined {
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value;
    }
    if (isRecordObject(part) && typeof part.value === 'string') {
      return part.value;
    }
  }
  return undefined;
}

function isToolUnavailableError(error: unknown): boolean {
  const message = formatError(error);
  return /was not contributed|invalid tool|unknown tool|does not have an implementation/i.test(message);
}

function isCancellationError(error: unknown): boolean {
  if (typeof vscode.CancellationError === 'function' && error instanceof vscode.CancellationError) {
    return true;
  }
  return error instanceof Error && (error.name === 'Canceled' || error.message === 'Canceled');
}

async function askInChat(
  stream: vscode.ChatResponseStream,
  questions: vscode.ChatQuestion[],
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await stream.questionCarousel(questions, true)) ?? {};
  } catch {
    return undefined;
  }
}

function reconstructSlashCommandPrompt(request: vscode.ChatRequest): string {
  const cmd = request.command?.trim();
  const body = request.prompt;
  if (cmd === undefined || cmd.length === 0 || cmd === 'plan' || cmd === 'btw') {
    return body;
  }
  const leadingToken = body.trimStart();
  if (leadingToken === `/${cmd}` || leadingToken.startsWith(`/${cmd} `)) {
    return body;
  }
  return body.trim().length > 0 ? `/${cmd} ${body}` : `/${cmd}`;
}

function getInvokedSlashCommandName(promptText: string): string | undefined {
  const match = /^\/([A-Za-z0-9_.:-]+)(?:\s|$)/.exec(promptText.trimStart());
  return match?.[1]?.toLowerCase();
}

async function buildPromptBlocks(
  request: vscode.ChatRequest,
  outputChannel: vscode.OutputChannel,
  sideChatPreamble?: string,
): Promise<AcpContentBlock[]> {
  const blocks: AcpContentBlock[] = [];
  const promptText = reconstructSlashCommandPrompt(request);
  const invokedCommand = getInvokedSlashCommandName(promptText);
  const references = request.references.filter((reference) => {
    if (reference.id === 'vscode.customizations.index') {
      return false;
    }
    if (invokedCommand !== undefined && isUriValue(reference.value) && isSkillMarkdownPath(reference.value.fsPath)) {
      const skillName = resolveSkillDisplayNameSync(reference.value.fsPath).toLowerCase();
      if (skillName === invokedCommand) {
        return false;
      }
    }
    return true;
  });

  const combinedText =
    sideChatPreamble !== undefined && sideChatPreamble.length > 0
      ? promptText.length > 0
        ? `${sideChatPreamble}\n\n${promptText}`
        : sideChatPreamble
      : promptText;

  if (combinedText.length > 0 || references.length === 0) {
    blocks.push({
      type: 'text',
      text: combinedText,
    });
  }

  for (const reference of references) {
    const converted = await convertReferenceToBlock(reference, outputChannel);
    if (converted !== undefined) {
      blocks.push(converted);
    }
  }

  return blocks;
}

async function convertReferenceToBlock(
  reference: vscode.ChatPromptReference,
  outputChannel: vscode.OutputChannel,
): Promise<AcpContentBlock | undefined> {
  const value = reference.value;

  if (isLocationValue(value)) {
    return await convertLocationReference(value, outputChannel);
  }

  if (isUriValue(value)) {
    return await convertUriReference(value, outputChannel);
  }

  if (isBinaryReference(value)) {
    return await convertBinaryReference(reference.id, value);
  }

  if (typeof value === 'string' && value.length > 0) {
    const text =
      reference.modelDescription !== undefined && reference.modelDescription.length > 0
        ? `${reference.modelDescription}: ${value}`
        : value;
    return {
      type: 'text',
      text,
    };
  }

  return undefined;
}

async function convertLocationReference(
  location: LocationLike,
  outputChannel: vscode.OutputChannel,
): Promise<AcpContentBlock> {
  const uri = location.uri;
  const startLine = location.range.start.line + 1;
  const endLine = location.range.end.line + 1;
  const rangedUri = `${uri.toString()}#L${startLine}-L${endLine}`;
  const displayName = `${getUriDisplayName(uri)}:${startLine}-${endLine}`;

  const text = await readLocationText(location, outputChannel);
  if (text !== undefined && text.length > 0) {
    return {
      type: 'resource',
      resource: {
        uri: rangedUri,
        mimeType: 'text/plain',
        text,
      },
    };
  }

  return {
    type: 'resource_link',
    uri: rangedUri,
    name: displayName,
  };
}

async function convertUriReference(uri: UriLike, outputChannel: vscode.OutputChannel): Promise<AcpContentBlock> {
  const displayName = getUriDisplayName(uri);
  const ext = path.extname(uri.fsPath.length > 0 ? uri.fsPath : uri.path).toLowerCase();
  const imageMime = IMAGE_MIME_BY_EXT[ext];

  if (imageMime !== undefined) {
    try {
      const vsUri = uri instanceof vscode.Uri ? uri : vscode.Uri.parse(uri.toString());
      const bytes = await vscode.workspace.fs.readFile(vsUri);
      return {
        type: 'image',
        mimeType: imageMime,
        data: Buffer.from(bytes).toString('base64'),
        uri: uri.toString(),
      };
    } catch (error: unknown) {
      outputChannel.appendLine(
        `[AgyChatParticipant] Failed reading image attachment ${uri.toString()}: ${formatError(error)}`,
      );
      return {
        type: 'resource_link',
        uri: uri.toString(),
        name: displayName,
        mimeType: imageMime,
      };
    }
  }

  return {
    type: 'resource_link',
    uri: uri.toString(),
    name: displayName,
  };
}

async function convertBinaryReference(referenceId: string, binary: BinaryReferenceLike): Promise<AcpContentBlock> {
  const rawBytes = typeof binary.data === 'function' ? await binary.data() : binary.data;
  const buffer = Buffer.from(rawBytes);
  const sourceUri = isUriValue(binary.reference) ? binary.reference.toString() : undefined;

  if (binary.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      mimeType: binary.mimeType,
      data: buffer.toString('base64'),
      uri: sourceUri,
    };
  }

  const refUri = sourceUri ?? `attachment:///${encodeURIComponent(referenceId)}`;
  if (binary.mimeType.startsWith('text/')) {
    return {
      type: 'resource',
      resource: {
        uri: refUri,
        mimeType: binary.mimeType,
        text: buffer.toString('utf8'),
      },
    };
  }

  return {
    type: 'resource',
    resource: { uri: refUri, mimeType: binary.mimeType, blob: buffer.toString('base64') },
  };
}

async function readLocationText(
  location: LocationLike,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const uriString = location.uri.toString();

  try {
    const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uriString);
    if (openDoc !== undefined) {
      if (location instanceof vscode.Location) {
        return openDoc.getText(location.range);
      }
      const range = new vscode.Range(
        location.range.start.line,
        location.range.start.character,
        location.range.end.line,
        location.range.end.character,
      );
      return openDoc.getText(range);
    }

    const vsUri = location.uri instanceof vscode.Uri ? location.uri : vscode.Uri.parse(uriString);
    const bytes = await vscode.workspace.fs.readFile(vsUri);
    const fullText = Buffer.from(bytes).toString('utf8');
    return sliceTextByRange(fullText, location.range);
  } catch (error: unknown) {
    outputChannel.appendLine(
      `[AgyChatParticipant] Could not read location snippet for ${uriString}: ${formatError(error)}`,
    );
    return undefined;
  }
}

function sliceTextByRange(fullText: string, range: RangeLike): string {
  const lines = fullText.split(/\r?\n/);
  if (lines.length === 0) {
    return '';
  }

  const startLine = Math.max(0, Math.min(range.start.line, lines.length - 1));
  const endLine = Math.max(startLine, Math.min(range.end.line, lines.length - 1));

  if (startLine === endLine) {
    const lineText = lines[startLine] ?? '';
    const startChar = Math.max(0, range.start.character);
    const endChar = range.end.character > startChar ? range.end.character : lineText.length;
    return lineText.slice(startChar, endChar);
  }

  const sliced: string[] = [];
  for (let lineIdx = startLine; lineIdx <= endLine; lineIdx += 1) {
    const lineText = lines[lineIdx] ?? '';
    if (lineIdx === startLine) {
      sliced.push(lineText.slice(Math.max(0, range.start.character)));
    } else if (lineIdx === endLine) {
      sliced.push(range.end.character > 0 ? lineText.slice(0, range.end.character) : lineText);
    } else {
      sliced.push(lineText);
    }
  }
  return sliced.join('\n');
}

function getUriDisplayName(uri: UriLike): string {
  const raw = uri.fsPath.length > 0 ? uri.fsPath : uri.path;
  const base = path.basename(raw);
  return base.length > 0 ? base : uri.toString();
}

function getModelIdSafely(model: vscode.LanguageModelChat | undefined): string | undefined {
  return model?.id;
}

function deriveSessionTitle(prompt: string): string | undefined {
  const firstLine = prompt.split(/\r?\n/)[0]?.trim() ?? '';
  if (firstLine.length === 0) {
    return undefined;
  }
  if (firstLine.length <= MAX_TITLE_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function isAuthenticationRequiredError(error: unknown): boolean {
  if (isRecordObject(error) && error.code === -32000) {
    return true;
  }
  const message = formatError(error);
  return message.includes('-32000') || /authentication\s+required/i.test(message);
}

function isUriValue(value: unknown): value is UriLike {
  if (value instanceof vscode.Uri) {
    return true;
  }
  if (!isRecordObject(value)) {
    return false;
  }
  return (
    typeof value.scheme === 'string' &&
    typeof value.fsPath === 'string' &&
    typeof value.path === 'string' &&
    typeof value.toString === 'function'
  );
}

function isLocationValue(value: unknown): value is LocationLike {
  if (value instanceof vscode.Location) {
    return true;
  }
  if (!isRecordObject(value)) {
    return false;
  }
  return isUriValue(value.uri) && isRangeLike(value.range);
}

function isRangeLike(value: unknown): value is RangeLike {
  if (!isRecordObject(value)) {
    return false;
  }
  return isPositionLike(value.start) && isPositionLike(value.end);
}

function isPositionLike(value: unknown): value is PositionLike {
  if (!isRecordObject(value)) {
    return false;
  }
  return typeof value.line === 'number' && typeof value.character === 'number';
}

function isBinaryReference(value: unknown): value is BinaryReferenceLike {
  if (!isRecordObject(value)) {
    return false;
  }
  if (typeof value.mimeType !== 'string') {
    return false;
  }
  return typeof value.data === 'function' || value.data instanceof Uint8Array;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractObjectProperty(target: unknown, key: string): unknown {
  if (!isRecordObject(target)) {
    return undefined;
  }
  return target[key];
}

function isTokenCancelled(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}

function createCancellationError(): Error {
  if (typeof vscode.CancellationError === 'function') {
    return new vscode.CancellationError();
  }
  const err = new Error('Canceled');
  err.name = 'Canceled';
  return err;
}

function isCancellingPromptRetryableError(error: unknown): boolean {
  return /the running prompt is being cancelled/i.test(formatError(error));
}

async function waitWithCancellation(ms: number, token: vscode.CancellationToken): Promise<void> {
  if (isTokenCancelled(token)) {
    throw createCancellationError();
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscription: vscode.Disposable | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      subscription?.dispose();
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    }, ms);
    if (typeof token.onCancellationRequested === 'function') {
      subscription = token.onCancellationRequested(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(createCancellationError());
        }
      });
    }
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
