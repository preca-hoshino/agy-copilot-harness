import * as vscode from 'vscode';
import type { AcpConfigOption, AcpSessionLoadResult } from '../acp/acpTypes.js';
import type { AcpBackendInterface } from '../shared/contracts.js';
import { ANTIGRAVITY_SCHEME } from '../shared/contracts.js';
import type { AgySessionController } from './agySessionController.js';
import { extractSessionIdFromUri } from './agySessionController.js';
import type { BrowserSubagentRenderer } from './browserSubagentRenderer.js';
import { TurnConverter } from './turnConverter.js';

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
      };
    }

    const sessionId = this.controller.resolveSessionId(rawSessionId);
    if (isTokenCancelled(token)) {
      throw createCancellationError();
    }
    const cwd = await raceWithCancellation(this.controller.getSessionCwd(sessionId), token);

    const converter = new TurnConverter(this.browserRenderer, sessionId, ANTIGRAVITY_SCHEME, this.attachmentDir);
    const updateSubscription = this.backend.onDidChangeUpdate((event) => {
      if (event.sessionId === sessionId && !isTokenCancelled(token)) {
        converter.processUpdate(event.update);
      }
    });

    let loadResult: AcpSessionLoadResult;
    try {
      loadResult = await raceWithCancellation(this.backend.loadSession(sessionId, cwd), token);
    } catch (error: unknown) {
      if (!isCancellationError(error)) {
        this.outputChannel.appendLine(
          `[AgySessionContentProvider] Failed to load session ${sessionId}: ${formatError(error)}`,
        );
      }
      throw error;
    } finally {
      updateSubscription.dispose();
    }

    if (isTokenCancelled(token)) {
      throw createCancellationError();
    }

    const converted = converter.finalizeHistory();

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
