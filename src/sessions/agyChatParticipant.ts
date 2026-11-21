import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpContentBlock, AcpRequestPermissionParams } from '../acp/acpTypes.js';
import type { AgyLanguageModelProvider } from '../models/agyLanguageModelProvider.js';
import type { AcpBackendInterface, QuotaServiceInterface } from '../shared/contracts.js';
import { ActiveAgyTurn } from './activeAgyTurn.js';
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

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    const sessionItem = context.chatSessionContext?.chatSessionItem;
    const rawSessionId =
      sessionItem !== undefined ? extractSessionIdFromUri(sessionItem.resource) : `untitled-${crypto.randomUUID()}`;

    if (context.chatSessionContext !== undefined && this.controller.isNewSession(rawSessionId)) {
      this.applyContextInitialOptions(rawSessionId, context.chatSessionContext);
    }

    let sessionId = this.controller.resolveSessionId(rawSessionId);

    const existingTurnMessage = { errorDetails: { message: 'Antigravity is still running a request in this session.' } };
    if (this.activeTurns.has(sessionId)) {
      return existingTurnMessage;
    }

    let activeTurn: ActiveAgyTurn | undefined;
    let releaseSession: (() => void) | undefined;
    try {
      const cwd = await this.controller.getSessionCwd(rawSessionId);
      if (!this.backend.isReady) {
        await this.backend.ensureStarted();
      }

      if (this.controller.isNewSession(rawSessionId)) {
        const created = await this.backend.newSession(cwd);
        sessionId = created.sessionId;
        this.controller.markSessionRealized(rawSessionId, sessionId);

        const derivedTitle = deriveSessionTitle(request.prompt);
        this.controller.updateSessionMetadata(sessionId, {
          ...(derivedTitle !== undefined ? { title: derivedTitle } : {}),
        });
      }

      releaseSession = await acquireSessionOperation(this.backend, sessionId, token);
      if (this.activeTurns.has(sessionId)) {
        return existingTurnMessage;
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

      const contentBlocks = await buildPromptBlocks(request, this.outputChannel);

      if (this.activeTurns.has(sessionId)) {
        return existingTurnMessage;
      }
      if (isTokenCancelled(token)) {
        this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
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
      activeTurn = turn;
      this.activeTurns.set(sessionId, turn);
      // Once published, a history provider can reattach instead of replaying. Release
      // the preparation lock so callers already queued behind it can do that too.
      releaseSession();
      releaseSession = undefined;
      this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.InProgress);

      const turnState: { needsInput: boolean; disconnected?: Error } = { needsInput: false };
      const getDisconnectError = (): Error | undefined => turnState.disconnected;
      const liveAdapter = new LiveStreamAdapter(
        this.browserRenderer,
        sessionId,
        turn,
        (change: vscode.ChatSessionFileChange): void => {
          this.controller.recordFileChange(sessionId, change);
        },
        (reason: string): void => {
          turnState.needsInput = true;
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.NeedsInput);
          this.outputChannel.appendLine(`[AgyChatParticipant] Session ${sessionId} needs input: ${reason}`);
        },
        this.attachmentDir,
      );

      let resetDrainTimer: (() => void) | undefined;
      let rejectDrain: ((error: Error) => void) | undefined;
      const backendSubscription = this.backend.onDidChangeBackendState((event) => {
        if (!event.ready) {
          const error = new Error('ACP backend disconnected while running the conversation.');
          turnState.disconnected = error;
          rejectDrain?.(error);
        }
      });
      const updateSubscription = this.backend.onDidChangeUpdate((event) => {
        if (event.sessionId !== sessionId || turnState.disconnected !== undefined) {
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
        liveAdapter.handleUpdate(event.update);
      });

      let pendingPermissions = 0;
      const permissionSubscription = this.backend.registerPermissionPrompt?.(sessionId, async (permission) => {
        pendingPermissions++;
        this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.NeedsInput);
        try {
          return await askTurnPermission(turn, permission);
        } catch (error: unknown) {
          this.outputChannel.appendLine(`[AgyChatParticipant] Permission prompt failed: ${formatError(error)}`);
          return undefined;
        } finally {
          pendingPermissions--;
          if (
            pendingPermissions === 0 &&
            !turnState.needsInput &&
            !isTokenCancelled(turn.stopToken) &&
            this.backend.isReady
          ) {
            this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.InProgress);
          }
        }
      });

      const fileWriteSubscription = this.backend.registerFileWriteHandler?.(sessionId, async (uri, write) => {
        await turn.externalEdit(uri, write, () => {
          liveAdapter.markExternalEdit(uri);
        });
      });

      const cancelSubscription = token.onCancellationRequested(() => {
        turn.stopRequestStream(stream);
      });

      this.activeDisposables.add(backendSubscription);
      this.activeDisposables.add(updateSubscription);
      this.activeDisposables.add(cancelSubscription);
      if (permissionSubscription !== undefined) {
        this.activeDisposables.add(permissionSubscription);
      }
      if (fileWriteSubscription !== undefined) {
        this.activeDisposables.add(fileWriteSubscription);
      }

      try {
        const promptResult = await this.backend.prompt(sessionId, contentBlocks, turn.stopToken);
        if (!turn.stopToken.isCancellationRequested && promptResult.stopReason !== 'cancelled') {
          const promptDisconnect = getDisconnectError();
          if (promptDisconnect !== undefined) {
            throw promptDisconnect;
          }
          await this.backend.waitForConversationFullyIdle(sessionId, turn.stopToken);
          const idleDisconnect = getDisconnectError();
          if (idleDisconnect !== undefined) {
            throw idleDisconnect;
          }
          await new Promise<void>((resolve, reject) => {
            let quietTimer: ReturnType<typeof setTimeout> | undefined;
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
            let cancellation: vscode.Disposable | undefined;
            rejectDrain = fail;
            cancellation = turn.stopToken.onCancellationRequested(() => {
              fail(new vscode.CancellationError());
            });
            resetDrainTimer = (): void => {
              clearTimeout(quietTimer);
              quietTimer = setTimeout(finish, LIVE_UPDATE_QUIET_MS);
            };
            if (turn.stopToken.isCancellationRequested) {
              fail(new vscode.CancellationError());
            } else {
              resetDrainTimer();
            }
          });
          const drainDisconnect = getDisconnectError();
          if (drainDisconnect !== undefined || !this.backend.isReady) {
            throw drainDisconnect ?? new Error('ACP backend disconnected while draining conversation updates.');
          }
        }
        if (!turnState.needsInput || turn.stopToken.isCancellationRequested) {
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
        }

        const metadata: Record<string, unknown> = {
          sessionId,
          ...(promptResult.stopReason !== undefined ? { stopReason: promptResult.stopReason } : {}),
        };
        return { metadata };
      } finally {
        try {
          liveAdapter.flush();
        } finally {
          backendSubscription.dispose();
          updateSubscription.dispose();
          cancelSubscription.dispose();
          if (permissionSubscription !== undefined) {
            permissionSubscription.dispose();
            this.activeDisposables.delete(permissionSubscription);
          }
          if (fileWriteSubscription !== undefined) {
            fileWriteSubscription.dispose();
            this.activeDisposables.delete(fileWriteSubscription);
          }
          this.activeDisposables.delete(backendSubscription);
          this.activeDisposables.delete(updateSubscription);
          this.activeDisposables.delete(cancelSubscription);
        }
      }
    } catch (error: unknown) {
      if ((activeTurn?.stopToken.isCancellationRequested ?? isTokenCancelled(token)) && !isAuthenticationRequiredError(error)) {
        if (activeTurn !== undefined) {
          this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Completed);
        }
        return {};
      }

      const errorMessage = formatError(error);
      this.outputChannel.appendLine(`[AgyChatParticipant] Turn failed for session ${sessionId}: ${errorMessage}`);
      this.controller.setSessionStatus(sessionId, vscode.ChatSessionStatus.Failed);

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
      if (activeTurn !== undefined) {
        activeTurn.finish();
        if (this.activeTurns.get(sessionId) === activeTurn) {
          this.activeTurns.delete(sessionId);
        }
      }
      releaseSession?.();
      try {
        await this.quotaService.refresh(true);
      } catch (refreshError: unknown) {
        this.outputChannel.appendLine(
          `[AgyChatParticipant] Quota refresh failed after turn: ${formatError(refreshError)}`,
        );
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

async function askTurnPermission(turn: ActiveAgyTurn, permission: AcpRequestPermissionParams): Promise<string | undefined> {
  const tool = permission.toolCall;
  const fields = tool.rawInput ?? {};
  const command = fields.CommandLine ?? fields.commandLine ?? fields.command ?? fields.cmd ?? fields.script;
  const cwd = fields.Cwd ?? fields.cwd ?? fields.WorkingDirectory;
  const isTerminal = tool.kind === 'execute' || /^(run_command|execute_command|bash|sh|pwsh|powershell|terminal)$/.test(tool.name ?? '');
  const requestId = crypto.randomUUID();
  const id = isTerminal && typeof command === 'string' && command.trim().length > 0
    ? `agy-terminal:${JSON.stringify({
        requestId,
        command,
        cwd: typeof cwd === 'string' ? cwd : undefined,
        options: permission.options.map(({ optionId, kind }) => ({ optionId, kind })),
      })}`
    : requestId;
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

  const stream = turn.permissionStream;
  if (typeof stream?.questionCarousel === 'function') {
    const answers = await Promise.race([
      askInChat(stream, [{
        id,
        type: vscode.ChatQuestionType.SingleSelect,
        title: 'Antigravity: Approve tool execution?',
        message,
        options: permission.options.map((option) => ({ id: option.optionId, label: option.name, value: option.optionId })),
        defaultValue: permission.options.find((option) => option.kind === 'reject_once')?.optionId ?? '',
      }]),
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
  const picked = await vscode.window.showQuickPick(permission.options.map((option) => ({
    label: option.name,
    description: option.kind,
    detail: typeof command === 'string' ? command : title,
    optionId: option.optionId,
  })), {
    placeHolder: `Antigravity permission request: ${title}`,
    ignoreFocusOut: true,
  }, turn.stopToken);
  return isTokenCancelled(turn.stopToken) ? undefined : picked?.optionId;
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

async function buildPromptBlocks(
  request: vscode.ChatRequest,
  outputChannel: vscode.OutputChannel,
): Promise<AcpContentBlock[]> {
  const blocks: AcpContentBlock[] = [];
  const references = request.references.filter((reference) => reference.id !== 'vscode.customizations.index');

  if (request.prompt.length > 0 || references.length === 0) {
    blocks.push({
      type: 'text',
      text: request.prompt,
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
