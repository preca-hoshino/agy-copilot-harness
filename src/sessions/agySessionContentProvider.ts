import * as vscode from 'vscode';
import type { AcpConfigOption, AcpSessionLoadResult } from '../acp/acpTypes.js';
import type { AcpBackendInterface, AgyContextWindowUsage } from '../shared/contracts.js';
import { ANTIGRAVITY_SCHEME } from '../shared/contracts.js';
import type { ActiveAgySession } from './agyChatParticipant.js';
import type { AgySessionController } from './agySessionController.js';
import { extractSessionIdFromUri } from './agySessionController.js';
import type { BrowserSubagentRenderer } from './browserSubagentRenderer.js';
import { acquireSessionOperation } from './sessionOperationCoordinator.js';
import { TurnConverter } from './turnConverter.js';

const REPLAY_QUIET_MS = 250;
const REPLAY_MAX_DRAIN_MS = 10_000;

export class AgySessionContentProvider implements vscode.ChatSessionContentProvider, vscode.Disposable {
  private readonly backend: AcpBackendInterface;
  private readonly controller: AgySessionController;
  private readonly browserRenderer: BrowserSubagentRenderer;
  private readonly outputChannel: vscode.OutputChannel;

  private readonly onDidChangeChatSessionOptionsEmitter = new vscode.EventEmitter<{
    resource: vscode.Uri;
    updates: readonly vscode.ChatSessionOptionUpdate[];
  }>();
  private readonly onDidChangeChatSessionProviderOptionsEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeChatSessionOptions: vscode.Event<{
    resource: vscode.Uri;
    updates: readonly vscode.ChatSessionOptionUpdate[];
  }> = this.onDidChangeChatSessionOptionsEmitter.event;
  public readonly onDidChangeChatSessionProviderOptions: vscode.Event<void> =
    this.onDidChangeChatSessionProviderOptionsEmitter.event;

  public constructor(
    backend: AcpBackendInterface,
    controller: AgySessionController,
    browserRenderer: BrowserSubagentRenderer,
    outputChannel: vscode.OutputChannel,
    private readonly attachmentDir?: string,
    private readonly getActiveSession?: (sessionId: string) => ActiveAgySession | undefined,
    private readonly onContextWindowResolved?: (
      modelId: string | undefined,
      size: number,
      authoritative: boolean,
    ) => void,
    private readonly getModelContextLimit?: (modelId: string | undefined) => number | undefined,
  ) {
    this.backend = backend;
    this.controller = controller;
    this.browserRenderer = browserRenderer;
    this.outputChannel = outputChannel;
  }

  public notifyOptionsChanged(resource: vscode.Uri, updates: readonly vscode.ChatSessionOptionUpdate[]): void {
    this.onDidChangeChatSessionOptionsEmitter.fire({ resource, updates });
  }

  public async provideChatSessionContent(
    resource: vscode.Uri,
    token: vscode.CancellationToken,
    _context: vscode.ChatSessionContentContext,
  ): Promise<vscode.ChatSession> {
    const rawSessionId = extractSessionIdFromUri(resource);

    if (this.controller.isNewSession(rawSessionId)) {
      const mode = this.controller.getSessionMode(rawSessionId);
      const title = this.controller.getSessionTitle(rawSessionId);
      return {
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        history: [],
        options: { mode },
        forkHandler: this.createForkHandler(),
      };
    }

    const sessionId = this.controller.resolveSessionId(rawSessionId);
    if (isTokenCancelled(token)) {
      throw createCancellationError();
    }
    const cwd = await raceWithCancellation(this.controller.getSessionCwd(sessionId), token);

    const active = this.getActiveSession?.(sessionId);
    if (active !== undefined) {
      const title = this.controller.getSessionTitle(sessionId);
      return {
        ...active,
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        options: { mode: this.controller.getSessionMode(sessionId) },
        forkHandler: this.createForkHandler(),
      };
    }

    // A cancelled caller returns immediately, but an already-sent load must retain its
    // session lock until the backend has finished sending its replay tail.
    return await raceWithCancellation(this.loadSessionContent(sessionId, cwd, token), token);
  }

  private async loadSessionContent(
    sessionId: string,
    cwd: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const release = await acquireSessionOperation(this.backend, sessionId, token);
    try {
      return await this.loadSessionContentLocked(sessionId, cwd, token);
    } finally {
      release();
    }
  }

  private async loadSessionContentLocked(
    sessionId: string,
    cwd: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    // ACP session/load can stop a running cascade; reattach without asking the backend to replay history.
    const active = this.getActiveSession?.(sessionId);
    if (active !== undefined) {
      const title = this.controller.getSessionTitle(sessionId);
      return {
        ...active,
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        options: { mode: this.controller.getSessionMode(sessionId) },
        forkHandler: this.createForkHandler(),
      };
    }

    const converter = new TurnConverter(this.browserRenderer, sessionId, ANTIGRAVITY_SCHEME, this.attachmentDir);
    let resetQuietTimer: (() => void) | undefined;
    let collectUpdates = true;
    let disconnected: Error | undefined;
    let rejectDrain: ((error: Error) => void) | undefined;
    const updateSubscription = this.backend.onDidChangeUpdate((event) => {
      if (event.sessionId === sessionId) {
        resetQuietTimer?.();
        if (collectUpdates && !isTokenCancelled(token)) {
          converter.processUpdate(event.update);
        }
      }
    });
    const backendSubscription = this.backend.onDidChangeBackendState((event) => {
      if (!event.ready) {
        disconnected = new Error('ACP backend disconnected while replaying session history.');
        collectUpdates = false;
        rejectDrain?.(disconnected);
      }
    });

    const drain = async (): Promise<void> => {
      if (disconnected !== undefined) {
        throw disconnected;
      }
      await new Promise<void>((resolve, reject) => {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          clearTimeout(quietTimer);
          clearTimeout(maximumTimer);
          resetQuietTimer = undefined;
          rejectDrain = undefined;
        };
        const maximumTimer = setTimeout(() => {
          cleanup();
          reject(new Error(`Replay drain timed out for session ${sessionId}; history may be incomplete.`));
        }, REPLAY_MAX_DRAIN_MS);
        rejectDrain = (error): void => {
          cleanup();
          reject(error);
        };
        resetQuietTimer = (): void => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => {
            cleanup();
            resolve();
          }, REPLAY_QUIET_MS);
        };
        resetQuietTimer();
      });
    };

    let loadResult: AcpSessionLoadResult;
    try {
      try {
        loadResult = await this.backend.loadSession(sessionId, cwd, token);
      } catch (error: unknown) {
        // A failed RPC can still have started replay. Quarantine its tail before releasing the lock.
        collectUpdates = false;
        if (!isCancellationError(error) && disconnected === undefined) {
          try {
            await drain();
          } catch (drainError: unknown) {
            this.outputChannel.appendLine(
              `[AgySessionContentProvider] Failed to drain replay for ${sessionId}: ${formatError(drainError)}`,
            );
          }
        }
        throw error;
      }
      await drain();
      if (disconnected !== undefined) {
        throw disconnected;
      }
    } catch (error: unknown) {
      if (!isCancellationError(error)) {
        this.outputChannel.appendLine(
          `[AgySessionContentProvider] Failed to load session ${sessionId}: ${formatError(error)}`,
        );
      }
      throw error;
    } finally {
      backendSubscription.dispose();
      updateSubscription.dispose();
    }

    if (isTokenCancelled(token)) {
      throw createCancellationError();
    }

    let detailedUsage: AgyContextWindowUsage | undefined;
    if (typeof this.backend.getSessionContextUsage === 'function') {
      try {
        detailedUsage = await raceWithCancellation(this.backend.getSessionContextUsage(sessionId), token);
      } catch (usageError: unknown) {
        if (isCancellationError(usageError)) {
          throw usageError;
        }
      }
    }

    const loadedModelId = extractModelIdFromLoadResult(loadResult);
    if (detailedUsage !== undefined && detailedUsage.maxContextTokens > 0) {
      this.onContextWindowResolved?.(loadedModelId, detailedUsage.maxContextTokens, true);
    }
    const fallbackContextLimit = this.getModelContextLimit?.(loadedModelId);
    const converted = converter.finalizeHistory(loadedModelId, detailedUsage, fallbackContextLimit);
    if (
      (detailedUsage === undefined || detailedUsage.maxContextTokens <= 0) &&
      converted.usage !== undefined &&
      converted.usage.size > 0
    ) {
      this.onContextWindowResolved?.(loadedModelId, converted.usage.size, false);
    }

    const loadedMode = extractModeFromLoadResult(loadResult);
    if (loadedMode !== undefined && loadedMode.length > 0) {
      this.controller.setSessionMode(sessionId, loadedMode, false);
    }

    this.controller.setSessionChanges(sessionId, converted.changes);

    const convertedTitle = converted.title?.trim();
    if (convertedTitle !== undefined && convertedTitle.length > 0) {
      this.controller.updateSessionMetadata(sessionId, { title: convertedTitle });
    }

    const activeMode = this.controller.getSessionMode(sessionId);
    const resolvedTitle =
      convertedTitle !== undefined && convertedTitle.length > 0
        ? convertedTitle
        : this.controller.getSessionTitle(sessionId);

    // ChatRequestTurn2 has `command: string | undefined` while @types/vscode ChatRequestTurn has `command?: string`
    // under exactOptionalPropertyTypes; VS Code's runtime expects the exact ChatRequestTurn2/ChatResponseTurn2 instances.
    const history = converted.turns as (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[];

    return {
      ...(resolvedTitle !== undefined && resolvedTitle.length > 0 ? { title: resolvedTitle } : {}),
      history,
      options: { mode: activeMode },
      forkHandler: this.createForkHandler(),
    };
  }

  private createForkHandler(): NonNullable<vscode.ChatSession['forkHandler']> {
    return async (
      sessionResource: vscode.Uri,
      request: vscode.ChatRequestTurn | undefined,
      forkToken: vscode.CancellationToken,
    ): Promise<vscode.ChatSessionItem> => {
      return await this.controller.createForkOrSideChatSession(sessionResource, request, forkToken);
    };
  }

  public async provideHandleOptionsChange(
    resource: vscode.Uri,
    updates: readonly vscode.ChatSessionOptionUpdate[],
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    const rawSessionId = extractSessionIdFromUri(resource);
    const resolvedSessionId = this.controller.resolveSessionId(rawSessionId);
    const isUnrealized = this.controller.isNewSession(rawSessionId);

    for (const update of updates) {
      const optionValue = extractOptionValue(update.value);
      if (optionValue === undefined || optionValue.length === 0) {
        continue;
      }

      if (update.optionId === 'mode') {
        const currentMode = this.controller.getSessionMode(rawSessionId);
        if (isUnrealized) {
          this.controller.setSessionMode(rawSessionId, optionValue, false);
        } else if (currentMode !== optionValue) {
          try {
            const options = await this.backend.setConfigOption(resolvedSessionId, 'mode', optionValue);
            const mode = options?.find((option) => option.id === 'mode')?.currentValue ?? optionValue;
            this.controller.setSessionMode(rawSessionId, mode, mode !== optionValue);
          } catch (error: unknown) {
            this.controller.setSessionMode(rawSessionId, currentMode);
            this.outputChannel.appendLine(
              `[AgySessionContentProvider] Failed to sync mode "${optionValue}" for session ${resolvedSessionId}: ${formatError(error)}`,
            );
          }
        }
      } else if (update.optionId === 'folder' && isUnrealized) {
        this.controller.setSessionCwd(rawSessionId, optionValue);
      }
    }
  }

  public dispose(): void {
    this.onDidChangeChatSessionOptionsEmitter.dispose();
    this.onDidChangeChatSessionProviderOptionsEmitter.dispose();
  }
}

function extractOptionValue(value: string | vscode.ChatSessionProviderOptionItem | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return value?.id;
}

function extractModeFromLoadResult(result: AcpSessionLoadResult): string | undefined {
  const modeFromModes = result.modes?.currentModeId;
  if (modeFromModes !== undefined && modeFromModes.length > 0) {
    return modeFromModes;
  }

  const modeOption = findConfigOption(result.configOptions, 'mode');
  if (modeOption !== undefined && modeOption.currentValue.length > 0) {
    return modeOption.currentValue;
  }

  return undefined;
}

function extractModelIdFromLoadResult(result: AcpSessionLoadResult): string | undefined {
  const modelFromModels = result.models?.currentModelId.trim();
  const rawModelId =
    modelFromModels !== undefined && modelFromModels.length > 0
      ? modelFromModels
      : findConfigOption(result.configOptions, 'model')?.currentValue.trim();

  if (rawModelId === undefined || rawModelId.length === 0) {
    return undefined;
  }
  if (rawModelId.startsWith('antigravity/') || rawModelId.startsWith('antigravity:')) {
    return rawModelId;
  }
  return `antigravity/${rawModelId}`;
}

function findConfigOption(
  options: readonly AcpConfigOption[] | undefined,
  targetId: string,
): AcpConfigOption | undefined {
  if (options === undefined) {
    return undefined;
  }
  return options.find((opt) => opt.id === targetId || opt.category === targetId);
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

function isCancellationError(error: unknown): boolean {
  if (typeof vscode.CancellationError === 'function' && error instanceof vscode.CancellationError) {
    return true;
  }
  return error instanceof Error && (error.name === 'Canceled' || error.message === 'Canceled');
}

async function raceWithCancellation<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
  if (token.isCancellationRequested) {
    throw createCancellationError();
  }
  if (typeof token.onCancellationRequested !== 'function') {
    return await promise;
  }

  let disposable: vscode.Disposable | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        disposable = token.onCancellationRequested(() => {
          reject(createCancellationError());
        });
      }),
    ]);
  } finally {
    disposable?.dispose();
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
