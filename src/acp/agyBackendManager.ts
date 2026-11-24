import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import type {
  AcpBackendInterface,
  AgyContextWindowUsage,
  AgyForkConversationResult,
  AgyModelTokenTotal,
  AgySlashCommandDescriptor,
  AgyTokenGroupUsage,
  AgyTurnFileDiff,
  ElicitationPrompt,
  FileWriteHandler,
  PermissionPrompt,
} from '../shared/contracts.js';
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpInitializeResult,
  AcpSessionListResult,
  AcpSessionLoadResult,
  AcpSessionPromptResult,
  AcpSessionUpdate,
} from './acpTypes.js';
import { ClientCapabilitiesHandler } from './clientCapabilitiesHandler.js';
import { JsonRpcError, JsonRpcTransport } from './jsonRpcTransport.js';

const BOOT_AUTH_RETRY_DELAYS_MS: readonly number[] = [400, 600, 800, 1000, 1200];
const RECONNECT_BACKOFF_DELAYS_MS: readonly number[] = [1000, 2000, 5000];
const LOG_POLL_INTERVAL_MS = 150;
const UPTIME_RESET_MS = 5000;
const HTTP_PORT_LOG_REGEX = /Language server listening on random port at (\d+) for HTTP(?:\s|$)/;
const IDLE_WAIT_TIMEOUT_MS = 10 * 60_000;
const IDLE_PORT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBootAuthError(err: unknown): boolean {
  if (err instanceof JsonRpcError) {
    return err.code === -32000 || err.message.toLowerCase().includes('authentication required');
  }
  if (err instanceof Error) {
    return err.message.toLowerCase().includes('authentication required');
  }
  return false;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postLocalJson(
  port: number,
  requestPath: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  signal: AbortSignal,
): Promise<{ readonly statusCode: number; readonly body: string }> {
  if (signal.aborted) {
    throw new Error(toErrorMessage(signal.reason));
  }
  return await new Promise<{ readonly statusCode: number; readonly body: string }>((resolve, reject) => {
    let settled = false;
    const finishReject = (err: unknown): void => {
      if (!settled) {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(toErrorMessage(err)));
      }
    };
    const finishResolve = (result: { readonly statusCode: number; readonly body: string }): void => {
      if (!settled) {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      }
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        });
        res.on('end', () => {
          finishResolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', finishReject);
      },
    );
    const onAbort = (): void => {
      req.destroy();
      finishReject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // WaitForConversationFullyIdle holds the response open until background work finishes;
    // avoid undici fetch's 5-minute headersTimeout so IDLE_WAIT_TIMEOUT_MS governs the wait.
    req.setTimeout(0);
    req.on('error', finishReject);
    req.end(body);
  });
}

function parseNonNegativeTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function extractFirstConnectFrameText(
  buffer: Buffer,
): { readonly kind: 'incomplete' } | { readonly kind: 'trailer' } | { readonly kind: 'frame'; readonly text: string } {
  if (buffer.length < 5) {
    return { kind: 'incomplete' };
  }
  const flags = buffer.readUInt8(0);
  const frameLength = buffer.readUInt32BE(1);
  if (buffer.length < 5 + frameLength) {
    return { kind: 'incomplete' };
  }
  if ((flags & 0x02) !== 0) {
    return { kind: 'trailer' };
  }
  const payload = buffer.subarray(5, 5 + frameLength);
  const rawPayload = (flags & 0x01) !== 0 ? zlib.gunzipSync(payload) : payload;
  return { kind: 'frame', text: rawPayload.toString('utf8') };
}

async function postLocalConnectFirstFrame(
  port: number,
  requestPath: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  signal: AbortSignal,
): Promise<{ readonly statusCode: number; readonly frameText?: string | undefined }> {
  if (signal.aborted) {
    throw new Error(toErrorMessage(signal.reason));
  }
  const jsonBytes = Buffer.from(body, 'utf8');
  const envelope = Buffer.alloc(5 + jsonBytes.length);
  envelope.writeUInt8(0, 0);
  envelope.writeUInt32BE(jsonBytes.length, 1);
  jsonBytes.copy(envelope, 5);

  return await new Promise<{ readonly statusCode: number; readonly frameText?: string | undefined }>(
    (resolve, reject) => {
      let settled = false;
      const finishReject = (err: unknown): void => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(toErrorMessage(err)));
        }
      };
      const finishResolve = (result: {
        readonly statusCode: number;
        readonly frameText?: string | undefined;
      }): void => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        }
      };
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: requestPath,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': String(envelope.length),
          },
          agent: false,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            finishResolve({ statusCode });
            req.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) => {
            if (settled) {
              return;
            }
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
            const combined = chunks.length === 1 ? (chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(chunks);
            try {
              const extracted = extractFirstConnectFrameText(combined);
              if (extracted.kind === 'incomplete') {
                return;
              }
              if (extracted.kind === 'trailer') {
                finishResolve({ statusCode });
                req.destroy();
                return;
              }
              finishResolve({ statusCode, frameText: extracted.text });
              req.destroy();
            } catch {
              finishResolve({ statusCode });
              req.destroy();
            }
          });
          res.on('end', () => {
            finishResolve({ statusCode });
          });
          res.on('error', finishReject);
        },
      );
      const onAbort = (): void => {
        req.destroy();
        finishReject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.setTimeout(0);
      req.on('error', finishReject);
      req.end(envelope);
    },
  );
}

function parseContextWindowUsageFrame(
  rawFrame: unknown,
): { readonly usage: AgyContextWindowUsage; readonly generatorMetadataIndex?: number | undefined } | undefined {
  if (!isRecord(rawFrame)) {
    return undefined;
  }
  const update = isRecord(rawFrame.update) ? rawFrame.update : rawFrame;
  const cw = update.contextWindowUsage;
  if (!isRecord(cw)) {
    return undefined;
  }
  const estimatedTokensUsed = parseNonNegativeTokenCount(cw.estimatedTokensUsed);
  const maxContextTokens = parseNonNegativeTokenCount(cw.maxContextTokens);
  if (estimatedTokensUsed === undefined || maxContextTokens === undefined || maxContextTokens <= 0) {
    return undefined;
  }
  const estimatedAfterCompaction = parseNonNegativeTokenCount(cw.estimatedAfterCompaction);
  const generatorMetadataIndex = parseNonNegativeTokenCount(cw.generatorMetadataIndex);
  const tokenGroups: AgyTokenGroupUsage[] = [];
  if (Array.isArray(cw.tokenGroups)) {
    for (const rawGroup of cw.tokenGroups) {
      if (!isRecord(rawGroup)) {
        continue;
      }
      const numTokens = parseNonNegativeTokenCount(rawGroup.numTokens) ?? 0;
      tokenGroups.push({
        name: typeof rawGroup.name === 'string' ? rawGroup.name : '',
        type: typeof rawGroup.type === 'string' ? rawGroup.type : 'TOKEN_TYPE_UNSPECIFIED',
        source: typeof rawGroup.source === 'string' ? rawGroup.source : 'TOKEN_SOURCE_UNSPECIFIED',
        numTokens,
      });
    }
  }
  return {
    usage: {
      estimatedTokensUsed,
      maxContextTokens,
      ...(estimatedAfterCompaction !== undefined ? { estimatedAfterCompaction } : {}),
      tokenGroups,
    },
    ...(generatorMetadataIndex !== undefined ? { generatorMetadataIndex } : {}),
  };
}

function extractLatestOutputTokensFromMetadata(payload: Record<string, unknown> | undefined): number | undefined {
  const rawList: unknown = payload?.generatorMetadata;
  if (!Array.isArray(rawList)) {
    return undefined;
  }
  const list: readonly unknown[] = rawList;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (!isRecord(entry) || !isRecord(entry.chatModel) || !isRecord(entry.chatModel.usage)) {
      continue;
    }
    const usage = entry.chatModel.usage;
    const direct = parseNonNegativeTokenCount(usage.outputTokens);
    if (direct !== undefined) {
      return direct;
    }
    const thinking = parseNonNegativeTokenCount(usage.thinkingOutputTokens);
    const response = parseNonNegativeTokenCount(usage.responseOutputTokens);
    if (thinking !== undefined || response !== undefined) {
      return (thinking ?? 0) + (response ?? 0);
    }
  }
  return undefined;
}

function extractModelTotalsFromMetadata(payload: Record<string, unknown> | undefined): AgyModelTokenTotal[] {
  const rawList: unknown = payload?.generatorMetadata;
  if (!Array.isArray(rawList)) {
    return [];
  }
  const byModel = new Map<string, { model: string; inputTokens: number; cachedTokens: number; outputTokens: number }>();
  for (const entry of rawList) {
    if (!isRecord(entry) || !isRecord(entry.chatModel) || !isRecord(entry.chatModel.usage)) {
      continue;
    }
    const usage = entry.chatModel.usage;
    const completionConfig = isRecord(entry.chatModel.completionConfig) ? entry.chatModel.completionConfig : undefined;
    const rawModel =
      (typeof entry.chatModel.model === 'string' && entry.chatModel.model.trim().length > 0
        ? entry.chatModel.model.trim()
        : undefined) ??
      (typeof completionConfig?.model === 'string' && completionConfig.model.trim().length > 0
        ? completionConfig.model.trim()
        : undefined) ??
      (typeof usage.model === 'string' && usage.model.trim().length > 0 ? usage.model.trim() : undefined) ??
      'Antigravity';

    const inputTokens = parseNonNegativeTokenCount(usage.inputTokens) ?? 0;
    const cachedTokens = parseNonNegativeTokenCount(usage.cacheReadTokens) ?? 0;
    const outputTokens =
      parseNonNegativeTokenCount(usage.outputTokens) ??
      (parseNonNegativeTokenCount(usage.thinkingOutputTokens) ?? 0) +
        (parseNonNegativeTokenCount(usage.responseOutputTokens) ?? 0);

    if (inputTokens === 0 && cachedTokens === 0 && outputTokens === 0) {
      continue;
    }

    const existing = byModel.get(rawModel);
    if (existing !== undefined) {
      existing.inputTokens += inputTokens;
      existing.cachedTokens += cachedTokens;
      existing.outputTokens += outputTokens;
    } else {
      byModel.set(rawModel, {
        model: rawModel,
        inputTokens,
        cachedTokens,
        outputTokens,
      });
    }
  }
  return [...byModel.values()];
}

function parseConfigOptionChoices(rawChoices: unknown[]): AcpConfigOption['options'] {
  const choices: AcpConfigOption['options'] = [];
  for (const choice of rawChoices) {
    if (isRecord(choice) && typeof choice.value === 'string' && typeof choice.name === 'string') {
      const description = typeof choice.description === 'string' ? choice.description : undefined;
      choices.push({
        value: choice.value,
        name: choice.name,
        description,
      });
    }
  }
  return choices;
}

function parseConfigOptions(raw: unknown[]): AcpConfigOption[] {
  const result: AcpConfigOption[] = [];
  for (const item of raw) {
    if (
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.type === 'string' &&
      typeof item.currentValue === 'string' &&
      Array.isArray(item.options)
    ) {
      const category = typeof item.category === 'string' ? item.category : undefined;
      result.push({
        id: item.id,
        name: item.name,
        category,
        type: item.type,
        currentValue: item.currentValue,
        options: parseConfigOptionChoices(item.options),
      });
    }
  }
  return result;
}

export class AgyBackendManager implements AcpBackendInterface, vscode.Disposable {
  public readonly csrfToken: string;

  private readonly storagePath: string;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly capabilitiesHandler: ClientCapabilitiesHandler;
  private readonly updateEmitter = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
  private readonly backendStateEmitter = new vscode.EventEmitter<{ ready: boolean; error?: string | undefined }>();
  private readonly availableCommandsEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeUpdate: vscode.Event<{ sessionId: string; update: AcpSessionUpdate }> =
    this.updateEmitter.event;
  public readonly onDidChangeBackendState: vscode.Event<{ ready: boolean; error?: string | undefined }> =
    this.backendStateEmitter.event;

  private _isReady = false;
  private _internalHttpPort: number | undefined;
  private process: ChildProcessWithoutNullStreams | undefined;
  private transport: JsonRpcTransport | undefined;
  private startPromise: Promise<void> | undefined;
  private bootOpQueue: Promise<void> = Promise.resolve();
  private bootAuthCompleted = false;
  private lastKnownConfigOptions: AcpConfigOption[] = [];

  private logPollTimer: ReturnType<typeof setInterval> | undefined;
  private logWatcher: fs.FSWatcher | undefined;
  private logScanInFlight = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private uptimeResetTimer: ReturnType<typeof setTimeout> | undefined;

  private consecutiveUnexpectedExits = 0;
  private intentionalStop = false;
  private disposed = false;
  private spawnCounter = 0;
  private stderrBuffer = '';
  private readonly promptOwners = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly promptGenerations = new Map<string, number>();
  private readonly idleWaits = new Set<AbortController>();
  private readonly availableCommandsBySession = new Map<string, AgySlashCommandDescriptor[]>();
  private latestAvailableCommands: AgySlashCommandDescriptor[] = [];
  private readonly clientAutoSessions = new Set<string>();

  public constructor(storagePath: string, outputChannel: vscode.OutputChannel) {
    this.storagePath = storagePath;
    this.outputChannel = outputChannel;
    this.csrfToken = randomUUID();
    this.capabilitiesHandler = new ClientCapabilitiesHandler(outputChannel);
  }

  public get isReady(): boolean {
    return this._isReady;
  }

  public get internalHttpPort(): number | undefined {
    return this._internalHttpPort;
  }

  public setSessionMode(sessionId: string, mode: string): void {
    if (mode === 'auto') {
      this.clientAutoSessions.add(sessionId);
    } else {
      this.clientAutoSessions.delete(sessionId);
    }
    this.capabilitiesHandler.setSessionMode(sessionId, mode);
  }

  public registerPermissionPrompt(sessionId: string, prompt: PermissionPrompt): vscode.Disposable {
    return this.capabilitiesHandler.registerPermissionPrompt(sessionId, prompt);
  }

  public registerElicitationPrompt(sessionId: string, prompt: ElicitationPrompt): vscode.Disposable {
    return this.capabilitiesHandler.registerElicitationPrompt(sessionId, prompt);
  }

  public registerFileWriteHandler(sessionId: string, handler: FileWriteHandler): vscode.Disposable {
    return this.capabilitiesHandler.registerFileWriteHandler(sessionId, handler);
  }

  public getLastKnownConfigOptions(): AcpConfigOption[] {
    return [...this.lastKnownConfigOptions];
  }

  public async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error('AgyBackendManager has been disposed');
    }
    if (this._isReady && this.process !== undefined && this.transport !== undefined) {
      return;
    }
    if (this.startPromise !== undefined) {
      await this.startPromise;
      return;
    }

    const activeStart = this.doStart();
    this.startPromise = activeStart;
    try {
      await activeStart;
    } finally {
      if (this.startPromise === activeStart) {
        this.startPromise = undefined;
      }
    }
  }

  public async listSessions(): Promise<AcpSessionListResult> {
    await this.ensureStarted();
    return await this.runSerializedBootOp(async () => {
      return await this.retryOnBootAuth(async () => {
        const transport = this.requireTransport();
        const sessions: AcpSessionListResult['sessions'] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await transport.sendRequest<AcpSessionListResult>(
            'session/list',
            cursor === undefined ? {} : { cursor },
          );
          sessions.push(...page.sessions);
          cursor = page.nextCursor ?? undefined;
          if (cursor !== undefined) {
            if (typeof cursor !== 'string' || seenCursors.has(cursor)) {
              throw new Error('Antigravity returned an invalid session list cursor.');
            }
            seenCursors.add(cursor);
          }
        } while (cursor !== undefined);
        return { sessions };
      });
    });
  }

  public async loadSession(
    sessionId: string,
    cwd: string,
    token?: vscode.CancellationToken,
  ): Promise<AcpSessionLoadResult> {
    await this.ensureStarted();
    const owner = this.process;
    return await this.runSerializedBootOp(async () => {
      const result = await this.retryOnBootAuth(async () => {
        if (token?.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        if (owner === undefined || owner !== this.process || !this._isReady) {
          throw new Error('ACP backend disconnected or restarted before session load was sent.');
        }
        return await this.requireTransport().sendRequest<AcpSessionLoadResult>('session/load', {
          sessionId,
          cwd,
          mcpServers: [],
        });
      });
      this.syncSessionMetadata(result);
      return result;
    });
  }

  public async resumeSession(sessionId: string, cwd: string): Promise<AcpSessionLoadResult> {
    await this.ensureStarted();
    return await this.runSerializedBootOp(async () => {
      const result = await this.retryOnBootAuth(async () => {
        return await this.requireTransport().sendRequest<AcpSessionLoadResult>('session/resume', {
          sessionId,
          cwd,
          mcpServers: [],
        });
      });
      this.syncSessionMetadata(result);
      return result;
    });
  }

  public async newSession(cwd: string): Promise<AcpSessionLoadResult> {
    await this.ensureStarted();
    return await this.runSerializedBootOp(async () => {
      const result = await this.retryOnBootAuth(async () => {
        return await this.requireTransport().sendRequest<AcpSessionLoadResult>('session/new', {
          cwd,
          mcpServers: [],
        });
      });
      this.syncSessionMetadata(result);
      return result;
    });
  }

  public async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<AcpConfigOption[] | undefined> {
    await this.ensureStarted();
    const isClientAutoMode = configId === 'mode' && value === 'auto';
    const wireValue = isClientAutoMode ? 'default' : value;
    const rawResult = await this.runSerializedBootOp(async () => {
      return await this.requireTransport().sendRequest<unknown>('session/set_config_option', {
        sessionId,
        configId,
        value: wireValue,
      });
    });

    let updatedOptions: AcpConfigOption[] | undefined;
    if (Array.isArray(rawResult)) {
      updatedOptions = parseConfigOptions(rawResult);
    } else if (isRecord(rawResult) && Array.isArray(rawResult.configOptions)) {
      updatedOptions = parseConfigOptions(rawResult.configOptions);
    }

    if (updatedOptions !== undefined) {
      this.lastKnownConfigOptions = updatedOptions;
    }
    if (configId === 'mode') {
      if (isClientAutoMode) {
        this.clientAutoSessions.add(sessionId);
        this.capabilitiesHandler.setSessionMode(sessionId, 'auto');
        if (updatedOptions !== undefined) {
          updatedOptions = updatedOptions.map((option) =>
            option.id === 'mode' ? { ...option, currentValue: 'auto' } : option,
          );
        }
      } else {
        this.clientAutoSessions.delete(sessionId);
        const confirmedMode = updatedOptions?.find((option) => option.id === configId)?.currentValue;
        this.capabilitiesHandler.setSessionMode(sessionId, confirmedMode ?? value);
      }
    }
    return updatedOptions;
  }

  public async prompt(
    sessionId: string,
    content: AcpContentBlock[],
    token?: vscode.CancellationToken,
  ): Promise<AcpSessionPromptResult> {
    await this.ensureStarted();
    const owner = this.process;
    const generation = (this.promptGenerations.get(sessionId) ?? 0) + 1;
    this.promptGenerations.set(sessionId, generation);
    return await this.runSerializedBootOp(async () => {
      if (token?.isCancellationRequested) {
        throw new Error('Prompt cancelled before it was sent.');
      }
      if (owner === undefined || owner !== this.process || !this._isReady) {
        throw new Error('ACP backend disconnected or restarted before prompt was sent.');
      }
      if (this.promptGenerations.get(sessionId) === generation) {
        this.promptOwners.delete(sessionId);
      }
      const result = await this.requireTransport().sendRequest<AcpSessionPromptResult>(
        'session/prompt',
        {
          sessionId,
          prompt: content,
        },
        0,
      );
      if (
        result.stopReason !== 'cancelled' &&
        !token?.isCancellationRequested &&
        this.promptGenerations.get(sessionId) === generation
      ) {
        this.promptOwners.set(sessionId, owner);
      }
      return result;
    });
  }

  public async waitForConversationFullyIdle(sessionId: string, token: vscode.CancellationToken): Promise<void> {
    const owner = this.promptOwners.get(sessionId);
    this.promptOwners.delete(sessionId);
    if (owner === undefined || owner !== this.process || !this._isReady || this.disposed) {
      throw new Error('Cannot confirm conversation is idle: the prompt backend disconnected or restarted.');
    }

    const controller = new AbortController();
    this.idleWaits.add(controller);
    const cancellation = token.onCancellationRequested(() => {
      controller.abort(new Error('Idle wait cancelled; background activity may still be running.'));
    });
    const timeout = setTimeout(() => {
      controller.abort(new Error('Timed out waiting for conversation to become fully idle.'));
    }, IDLE_WAIT_TIMEOUT_MS);
    const portDeadline = Date.now() + IDLE_PORT_TIMEOUT_MS;
    try {
      if (token.isCancellationRequested) {
        controller.abort(new Error('Idle wait cancelled; background activity may still be running.'));
      }
      while (this._internalHttpPort === undefined) {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        if (Date.now() >= portDeadline) {
          throw new Error('Cannot confirm conversation is idle: local HTTP port was not detected.');
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(new Error(toErrorMessage(controller.signal.reason)));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, LOG_POLL_INTERVAL_MS);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      const response = await postLocalJson(
        this._internalHttpPort,
        '/exa.language_server_pb.LanguageServerService/WaitForConversationFullyIdle',
        {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': this.csrfToken,
        },
        JSON.stringify({ conversationId: sessionId }),
        controller.signal,
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`WaitForConversationFullyIdle returned HTTP ${response.statusCode}.`);
      }
      const payload: unknown = JSON.parse(response.body);
      if (!isRecord(payload) || Object.keys(payload).length !== 0) {
        throw new Error('WaitForConversationFullyIdle returned an unexpected response.');
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
    } catch (error: unknown) {
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
      throw new Error(`Cannot confirm conversation is fully idle: ${toErrorMessage(reason)}`);
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
      this.idleWaits.delete(controller);
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    await Promise.resolve();
    if (this.transport !== undefined && this._isReady) {
      this.transport.sendNotification('session/cancel', { sessionId });
    }
  }

  public async logout(): Promise<void> {
    await this.ensureStarted();
    await this.requireTransport().sendRequest<unknown>('auth/logout', {});
    this.bootAuthCompleted = false;
  }

  public async restart(): Promise<void> {
    if (this.disposed) {
      throw new Error('AgyBackendManager has been disposed');
    }
    this.clearReconnectTimer();
    this.consecutiveUnexpectedExits = 0;
    this.intentionalStop = true;
    try {
      await this.stopCurrentProcess();
    } finally {
      this.intentionalStop = false;
    }
    await this.ensureStarted();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.intentionalStop = true;
    this.clearReconnectTimer();
    this.clearUptimeResetTimer();
    this.stopLogMonitor();
    this.teardownActiveInstances();
    this.capabilitiesHandler.dispose();
    this.updateEmitter.dispose();
    this.backendStateEmitter.dispose();
    this.availableCommandsEmitter.dispose();
  }

  public getAvailableCommands(sessionId?: string): AgySlashCommandDescriptor[] {
    if (sessionId !== undefined) {
      const scoped = this.availableCommandsBySession.get(sessionId);
      if (scoped !== undefined) {
        return [...scoped];
      }
    }
    return [...this.latestAvailableCommands];
  }

  public onDidChangeAvailableCommands(listener: () => void): vscode.Disposable {
    return this.availableCommandsEmitter.event(listener);
  }

  public async fetchSlashCommands(workspaceUris?: string[], sessionId?: string): Promise<AgySlashCommandDescriptor[]> {
    const body: Record<string, unknown> = {};
    if (sessionId !== undefined && sessionId.length > 0) {
      body.cascadeId = sessionId;
    }
    if (workspaceUris !== undefined && workspaceUris.length > 0) {
      body.workspaceUris = workspaceUris;
    }
    const payload = await this.callLanguageServerJson(
      '/exa.language_server_pb.LanguageServerService/GetSlashCommands',
      body,
    );
    const merged = new Map<string, AgySlashCommandDescriptor>();
    for (const cmd of this.getAvailableCommands(sessionId)) {
      merged.set(cmd.name, cmd);
    }
    if (payload !== undefined && Array.isArray(payload.commands)) {
      for (const raw of payload.commands) {
        if (!isRecord(raw) || typeof raw.name !== 'string') {
          continue;
        }
        const trimmedName = raw.name.replace(/^\/+/, '').trim();
        if (trimmedName.length === 0 || merged.has(trimmedName)) {
          continue;
        }
        const desc =
          typeof raw.description === 'string' && raw.description.trim().length > 0 ? raw.description.trim() : undefined;
        merged.set(trimmedName, {
          name: trimmedName,
          ...(desc !== undefined ? { description: desc } : {}),
          source: 'ls',
        });
      }
    }
    return Array.from(merged.values());
  }

  public async forkConversation(
    sourceCascadeId: string,
    forkAtStepIndex?: number,
  ): Promise<AgyForkConversationResult | undefined> {
    if (sourceCascadeId.trim().length === 0) {
      return undefined;
    }
    const body: Record<string, unknown> = { sourceCascadeId };
    if (forkAtStepIndex !== undefined) {
      body.forkAtStepIndex = forkAtStepIndex;
    }
    const payload = await this.callLanguageServerJson(
      '/exa.language_server_pb.LanguageServerService/ForkConversation',
      body,
      5000,
    );
    if (payload !== undefined && typeof payload.newCascadeId === 'string' && payload.newCascadeId.length > 0) {
      return { newCascadeId: payload.newCascadeId };
    }
    return undefined;
  }

  public async getTurnFileDiff(
    conversationId: string,
    fileUri: string,
    stepIndex?: number,
  ): Promise<AgyTurnFileDiff | undefined> {
    if (conversationId.trim().length === 0 || fileUri.trim().length === 0) {
      return undefined;
    }
    const body: Record<string, unknown> = {
      conversationId,
      fileUris: [fileUri],
      statsOnly: false,
    };
    if (stepIndex !== undefined) {
      body.stepIndex = stepIndex;
    }
    const payload = await this.callLanguageServerJson(
      '/exa.language_server_pb.LanguageServerService/GetTurnDiff',
      body,
    );
    if (payload === undefined) {
      return undefined;
    }
    const fileDiffs = payload.fileDiffs;
    let entry: Record<string, unknown> | undefined;
    if (isRecord(fileDiffs)) {
      const direct = fileDiffs[fileUri];
      if (isRecord(direct)) {
        entry = direct;
      } else {
        for (const candidate of Object.values(fileDiffs)) {
          if (isRecord(candidate)) {
            entry = candidate;
            break;
          }
        }
      }
    } else if (Array.isArray(fileDiffs)) {
      for (const item of fileDiffs) {
        if (isRecord(item)) {
          entry = isRecord(item.value) ? item.value : item;
          break;
        }
      }
    }
    if (entry === undefined) {
      return undefined;
    }
    const originalContent =
      typeof entry.originalContent === 'string'
        ? entry.originalContent
        : typeof entry.beforeContent === 'string'
          ? entry.beforeContent
          : typeof entry.oldContent === 'string'
            ? entry.oldContent
            : undefined;
    const modifiedContent =
      typeof entry.modifiedContent === 'string'
        ? entry.modifiedContent
        : typeof entry.afterContent === 'string'
          ? entry.afterContent
          : typeof entry.newContent === 'string'
            ? entry.newContent
            : undefined;
    return { originalContent, modifiedContent };
  }

  public async acknowledgeCodeEdit(
    cascadeId: string,
    absoluteUri: string,
    contents: string,
    accept: boolean,
  ): Promise<boolean> {
    if (cascadeId.trim().length === 0 || absoluteUri.trim().length === 0) {
      return false;
    }
    const payload = await this.callLanguageServerJson(
      '/exa.language_server_pb.LanguageServerService/AcknowledgeCascadeCodeEdit',
      {
        cascadeId,
        absoluteUri,
        contents,
        accept,
      },
    );
    return payload !== undefined;
  }

  public async getSessionContextUsage(sessionId: string): Promise<AgyContextWindowUsage | undefined> {
    const trimmedSessionId = sessionId.trim();
    if (
      trimmedSessionId.length === 0 ||
      this.disposed ||
      this._internalHttpPort === undefined ||
      this.csrfToken.length === 0
    ) {
      return undefined;
    }
    const framePayload = await this.callLanguageServerConnectFirstFrame(
      '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      {
        conversationId: trimmedSessionId,
        subscriberId: `agy-copilot-harness-usage-${randomUUID().slice(0, 8)}`,
        initialStepsPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        initialGeneratorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
      },
      2500,
    );
    const parsed = parseContextWindowUsageFrame(framePayload);
    if (parsed === undefined) {
      return undefined;
    }

    let completionTokens: number | undefined;
    let modelTotals: AgyModelTokenTotal[] = [];
    const metadataOffset =
      parsed.generatorMetadataIndex !== undefined ? Math.max(0, parsed.generatorMetadataIndex - 50) : 0;
    if (parsed.generatorMetadataIndex !== undefined) {
      const metadataPayload = await this.callLanguageServerJson(
        '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata',
        {
          cascadeId: trimmedSessionId,
          generatorMetadataOffset: metadataOffset,
          includeMessages: false,
        },
        1500,
      );
      completionTokens = extractLatestOutputTokensFromMetadata(metadataPayload);
      modelTotals = extractModelTotalsFromMetadata(metadataPayload);
    }

    return {
      ...parsed.usage,
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(modelTotals.length > 0 ? { modelTotals } : {}),
    };
  }

  private async callLanguageServerConnectFirstFrame(
    methodPath: string,
    body: Record<string, unknown>,
    timeoutMs = 2500,
  ): Promise<unknown> {
    if (this.disposed || this._internalHttpPort === undefined || this.csrfToken.length === 0) {
      return undefined;
    }
    try {
      const response = await postLocalConnectFirstFrame(
        this._internalHttpPort,
        methodPath,
        {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': this.csrfToken,
        },
        JSON.stringify(body),
        AbortSignal.timeout(timeoutMs),
      );
      if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        response.frameText === undefined ||
        response.frameText.length === 0
      ) {
        return undefined;
      }
      return JSON.parse(response.frameText) as unknown;
    } catch {
      return undefined;
    }
  }

  private async callLanguageServerJson(
    methodPath: string,
    body: Record<string, unknown>,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.disposed || this._internalHttpPort === undefined || this.csrfToken.length === 0) {
      return undefined;
    }
    try {
      const response = await postLocalJson(
        this._internalHttpPort,
        methodPath,
        {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': this.csrfToken,
        },
        JSON.stringify(body),
        AbortSignal.timeout(timeoutMs),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(response.body);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async doStart(): Promise<void> {
    const cliPath = this.discoverCliPath();
    const config = vscode.workspace.getConfiguration('antigravityHarness');
    const configuredAppDataDir = config.get<string>('appDataDir')?.trim();
    const appDataDir =
      configuredAppDataDir !== undefined && configuredAppDataDir.length > 0 ? configuredAppDataDir : 'antigravity';

    await fsPromises.mkdir(this.storagePath, { recursive: true });
    await this.cleanupOldLogFiles();

    const scratchDir = path.join(os.homedir(), '.gemini', appDataDir, 'scratch');
    await fsPromises.mkdir(scratchDir, { recursive: true });

    this.spawnCounter += 1;
    const logPath = path.join(this.storagePath, `agy-acp-${Date.now()}-${this.spawnCounter}.log`);
    await fsPromises.writeFile(logPath, '', 'utf8');

    this._isReady = false;
    this._internalHttpPort = undefined;
    this.bootAuthCompleted = false;
    this.stderrBuffer = '';

    const args = ['acp', '--app-data-dir', appDataDir, '--log-file', logPath];
    const mainAgent = config.get<string>('mainAgent')?.trim();
    if (mainAgent !== undefined && mainAgent.length > 0) {
      args.push('--agent', mainAgent);
    }
    this.outputChannel.appendLine(`[ACP Backend] Spawning "${cliPath}" ${args.join(' ')}`);

    const child = spawn(cliPath, args, {
      cwd: scratchDir,
      env: {
        ...process.env,
        ANTIGRAVITY_SERVER_CSRF_TOKEN: this.csrfToken,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process = child;

    let rejectSpawn: ((err: Error) => void) | undefined;
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      rejectSpawn = reject;
    });

    child.on('error', (err: Error) => {
      const error = new Error(`Antigravity CLI process error ("${cliPath}"): ${err.message}`);
      this.outputChannel.appendLine(`[ACP Backend] ${error.message}`);
      if (rejectSpawn !== undefined) {
        const cb = rejectSpawn;
        rejectSpawn = undefined;
        cb(error);
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.handleStderrChunk(chunk);
    });

    const transport = new JsonRpcTransport(child.stdout, child.stdin, {
      requestTimeoutMs: 60_000,
      onNotification: (method: string, params: unknown): void => {
        this.handleNotification(method, params);
      },
      onRequest: async (method: string, params: unknown): Promise<unknown> => {
        return await this.capabilitiesHandler.handleRequest(method, params);
      },
      onError: (err: Error): void => {
        this.outputChannel.appendLine(`[ACP Transport] ${err.message}`);
      },
      onClose: (): void => {
        this.handleProcessExit(child, null, null);
      },
    });
    this.transport = transport;

    this.startLogMonitor(logPath, child);

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleProcessExit(child, code, signal);
    });

    try {
      const initPromise = transport.sendRequest<AcpInitializeResult>('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
          elicitation: {
            form: {},
          },
        },
      });

      const initResult = await Promise.race([initPromise, spawnErrorPromise]);
      rejectSpawn = undefined;
      if (this.process !== child || this.disposed) {
        return;
      }

      this._isReady = true;
      this.scheduleUptimeReset();
      const serverName = initResult.agentInfo?.name ?? 'Antigravity ACP';
      const serverVersion = initResult.agentInfo?.version ?? 'unknown';
      this.outputChannel.appendLine(
        `[ACP Backend] Initialized ${serverName} (${serverVersion}), protocol v${initResult.protocolVersion}`,
      );
      this.backendStateEmitter.fire({ ready: true });
    } catch (err: unknown) {
      if (this.process === child) {
        this.stopLogMonitor();
        this.teardownActiveInstances();
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private discoverCliPath(): string {
    const configured = vscode.workspace.getConfiguration('antigravityHarness').get<string>('cliPath')?.trim();
    if (configured !== undefined && configured.length > 0) {
      if (isExistingFile(configured)) {
        return configured;
      }
      this.outputChannel.appendLine(`[ACP Backend] Configured cliPath "${configured}" does not exist; falling back.`);
    }

    const binaryName = process.platform === 'win32' ? 'agy.exe' : 'agy';
    const homeCandidate = path.join(os.homedir(), '.gemini', 'bin', binaryName);
    if (isExistingFile(homeCandidate)) {
      return homeCandidate;
    }

    const envPath = process.env.PATH ?? process.env.Path ?? '';
    const candidateNames = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];
    for (const dir of envPath.split(path.delimiter)) {
      const trimmedDir = dir.trim();
      if (trimmedDir.length === 0) {
        continue;
      }
      for (const name of candidateNames) {
        const candidate = path.join(trimmedDir, name);
        if (isExistingFile(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error(
      'Unable to find Antigravity CLI (agy / agy.exe). Set "antigravityHarness.cliPath" or install it into ~/.gemini/bin.',
    );
  }

  private startLogMonitor(logPath: string, owner: ChildProcessWithoutNullStreams): void {
    this.stopLogMonitor();
    this.logScanInFlight = false;

    const canContinue = (): boolean => !this.disposed && this.process === owner && this._internalHttpPort === undefined;

    const scanLog = async (): Promise<void> => {
      if (!canContinue() || this.logScanInFlight) {
        return;
      }
      this.logScanInFlight = true;
      try {
        const content = await fsPromises.readFile(logPath, 'utf8');
        if (!canContinue()) {
          return;
        }
        const match = HTTP_PORT_LOG_REGEX.exec(content);
        const portGroup = match?.[1];
        if (portGroup !== undefined) {
          const parsedPort = Number.parseInt(portGroup, 10);
          if (Number.isInteger(parsedPort) && parsedPort > 0) {
            this._internalHttpPort = parsedPort;
            this.outputChannel.appendLine(`[ACP Backend] Detected internal HTTP port ${parsedPort}`);
            this.stopLogMonitor();
          }
        }
      } catch {
        /* log file may not exist or be momentarily inaccessible */
      } finally {
        this.logScanInFlight = false;
      }
    };

    try {
      this.logWatcher = fs.watch(logPath, () => {
        void scanLog();
      });
      this.logWatcher.on('error', () => {
        /* rely on polling fallback */
      });
    } catch {
      /* rely on polling fallback */
    }

    this.logPollTimer = setInterval(() => {
      void scanLog();
    }, LOG_POLL_INTERVAL_MS);
    void scanLog();
  }

  private stopLogMonitor(): void {
    if (this.logPollTimer !== undefined) {
      clearInterval(this.logPollTimer);
      this.logPollTimer = undefined;
    }
    if (this.logWatcher !== undefined) {
      this.logWatcher.close();
      this.logWatcher = undefined;
    }
  }

  private async cleanupOldLogFiles(): Promise<void> {
    try {
      const entries = await fsPromises.readdir(this.storagePath);
      const logFiles = entries.filter((name) => name.startsWith('agy-acp-') && name.endsWith('.log'));
      for (const name of logFiles) {
        try {
          await fsPromises.unlink(path.join(this.storagePath, name));
        } catch {
          /* ignore locked log files from still-exiting processes */
        }
      }
    } catch {
      /* ignore directory read failures */
    }
  }

  private handleStderrChunk(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stderrBuffer += text;
    let newlineIndex = this.stderrBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.outputChannel.appendLine(`[agy stderr] ${line}`);
      }
      newlineIndex = this.stderrBuffer.indexOf('\n');
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !isRecord(params)) {
      return;
    }
    const sessionId = params.sessionId;
    const update = params.update;
    if (typeof sessionId !== 'string' || !isRecord(update) || typeof update.sessionUpdate !== 'string') {
      return;
    }

    let emittedUpdate: Record<string, unknown> = update;
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      this.lastKnownConfigOptions = parseConfigOptions(update.configOptions);
    } else if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
      const effectiveModeId =
        this.clientAutoSessions.has(sessionId) && update.currentModeId === 'default' ? 'auto' : update.currentModeId;
      if (effectiveModeId !== 'auto') {
        this.clientAutoSessions.delete(sessionId);
      }
      this.capabilitiesHandler.setSessionMode(sessionId, effectiveModeId);
      if (effectiveModeId !== update.currentModeId) {
        emittedUpdate = { ...update, currentModeId: effectiveModeId };
      }
    } else if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      const normalized: AgySlashCommandDescriptor[] = [];
      for (const item of update.availableCommands) {
        if (!isRecord(item) || typeof item.name !== 'string') {
          continue;
        }
        const trimmedName = item.name.replace(/^\/+/, '').trim();
        if (trimmedName.length === 0) {
          continue;
        }
        const description =
          typeof item.description === 'string' && item.description.trim().length > 0
            ? item.description.trim()
            : undefined;
        const inputObj = isRecord(item.input) ? item.input : undefined;
        const argumentHint =
          inputObj !== undefined && typeof inputObj.hint === 'string' && inputObj.hint.trim().length > 0
            ? inputObj.hint.trim()
            : undefined;
        normalized.push({
          name: trimmedName,
          ...(description !== undefined ? { description } : {}),
          ...(argumentHint !== undefined ? { argumentHint } : {}),
          source: 'acp',
        });
      }
      this.availableCommandsBySession.set(sessionId, normalized);
      this.latestAvailableCommands = normalized;
      this.availableCommandsEmitter.fire();
    }

    const sessionUpdate: AcpSessionUpdate = {
      ...emittedUpdate,
      sessionUpdate: update.sessionUpdate,
    };

    this.updateEmitter.fire({
      sessionId,
      update: sessionUpdate,
    });
  }

  private syncSessionMetadata(result: AcpSessionLoadResult): void {
    const preserveClientAuto = (modeId: string): string =>
      this.clientAutoSessions.has(result.sessionId) && modeId === 'default' ? 'auto' : modeId;
    if (result.configOptions !== undefined) {
      this.lastKnownConfigOptions = result.configOptions;
      const modeOption = result.configOptions.find((opt) => opt.id === 'mode');
      if (modeOption !== undefined) {
        this.capabilitiesHandler.setSessionMode(result.sessionId, preserveClientAuto(modeOption.currentValue));
      }
    }
    if (result.modes !== undefined) {
      this.capabilitiesHandler.setSessionMode(result.sessionId, preserveClientAuto(result.modes.currentModeId));
    }
  }

  private async runSerializedBootOp<T>(operation: () => Promise<T>): Promise<T> {
    if (this.bootAuthCompleted) {
      return await operation();
    }

    const previous = this.bootOpQueue;
    let releaseQueue: () => void = () => {
      /* initialized synchronously */
    };
    this.bootOpQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      const result = await operation();
      this.bootAuthCompleted = true;
      return result;
    } finally {
      releaseQueue();
    }
  }

  private async retryOnBootAuth<T>(operation: () => Promise<T>): Promise<T> {
    if (this.bootAuthCompleted) {
      return await operation();
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= BOOT_AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await operation();
      } catch (err: unknown) {
        lastError = err;
        const backoffMs = BOOT_AUTH_RETRY_DELAYS_MS[attempt];
        if (!isBootAuthError(err) || backoffMs === undefined || this.disposed || !this._isReady) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        this.outputChannel.appendLine(
          `[ACP Backend] Boot auth pending (-32000), retrying in ${backoffMs}ms (attempt ${attempt + 1}/${BOOT_AUTH_RETRY_DELAYS_MS.length})`,
        );
        await delay(backoffMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private requireTransport(): JsonRpcTransport {
    if (this.transport === undefined) {
      throw new Error('ACP JSON-RPC transport is not active');
    }
    return this.transport;
  }

  private handleProcessExit(
    owner: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.process !== owner) {
      return;
    }

    this.clearUptimeResetTimer();
    this.stopLogMonitor();
    this.teardownActiveInstances();

    const reason = signal !== null ? `signal ${signal}` : `exit code ${code !== null ? String(code) : 'unknown'}`;
    this.outputChannel.appendLine(`[ACP Backend] Process exited (${reason})`);

    if (this.disposed || this.intentionalStop) {
      this.backendStateEmitter.fire({ ready: false });
      return;
    }

    this.backendStateEmitter.fire({
      ready: false,
      error: `Antigravity ACP backend exited unexpectedly (${reason})`,
    });

    const backoffMs = RECONNECT_BACKOFF_DELAYS_MS[this.consecutiveUnexpectedExits];
    if (backoffMs === undefined) {
      this.outputChannel.appendLine('[ACP Backend] Exceeded maximum unexpected-exit restart attempts.');
      return;
    }

    this.consecutiveUnexpectedExits += 1;
    this.outputChannel.appendLine(
      `[ACP Backend] Scheduling restart attempt ${this.consecutiveUnexpectedExits}/${RECONNECT_BACKOFF_DELAYS_MS.length} in ${backoffMs}ms`,
    );
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, backoffMs);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.disposed || this.intentionalStop) {
      return;
    }
    try {
      await this.ensureStarted();
    } catch (err: unknown) {
      const msg = toErrorMessage(err);
      this.outputChannel.appendLine(`[ACP Backend] Restart attempt failed: ${msg}`);
      this.backendStateEmitter.fire({ ready: false, error: msg });

      if (this.reconnectTimer === undefined && this.canAutoRestart()) {
        const nextBackoffMs = RECONNECT_BACKOFF_DELAYS_MS[this.consecutiveUnexpectedExits];
        if (nextBackoffMs !== undefined) {
          this.consecutiveUnexpectedExits += 1;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.attemptReconnect();
          }, nextBackoffMs);
        }
      }
    }
  }

  private async stopCurrentProcess(): Promise<void> {
    this.clearUptimeResetTimer();
    this.stopLogMonitor();
    this.abortIdleWaits();

    const activeProcess = this.process;
    const activeTransport = this.transport;

    this.process = undefined;
    this.transport = undefined;
    this._isReady = false;
    this._internalHttpPort = undefined;
    this.bootAuthCompleted = false;

    activeTransport?.dispose();
    this.backendStateEmitter.fire({ ready: false });

    if (activeProcess === undefined || activeProcess.exitCode !== null || activeProcess.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(forceTimer);
          resolve();
        }
      };

      activeProcess.once('exit', finish);
      const forceTimer = setTimeout(() => {
        try {
          activeProcess.kill('SIGKILL');
        } catch {
          /* process may have already exited */
        }
        finish();
      }, 1500);

      try {
        activeProcess.kill();
      } catch {
        finish();
      }
    });
  }

  private teardownActiveInstances(): void {
    this.abortIdleWaits();
    const activeTransport = this.transport;
    const activeProcess = this.process;
    this.transport = undefined;
    this.process = undefined;
    this._isReady = false;
    this._internalHttpPort = undefined;
    this.bootAuthCompleted = false;

    activeTransport?.dispose();
    if (activeProcess !== undefined && activeProcess.exitCode === null && !activeProcess.killed) {
      try {
        activeProcess.kill();
      } catch {
        /* ignore kill errors during teardown */
      }
    }
  }

  private scheduleUptimeReset(): void {
    this.clearUptimeResetTimer();
    this.uptimeResetTimer = setTimeout(() => {
      this.uptimeResetTimer = undefined;
      if (!this.disposed && this._isReady) {
        this.consecutiveUnexpectedExits = 0;
      }
    }, UPTIME_RESET_MS);
  }

  private abortIdleWaits(): void {
    for (const controller of this.idleWaits) {
      controller.abort(new Error('ACP backend disconnected or restarted.'));
    }
    this.promptOwners.clear();
    this.promptGenerations.clear();
  }

  private clearUptimeResetTimer(): void {
    if (this.uptimeResetTimer !== undefined) {
      clearTimeout(this.uptimeResetTimer);
      this.uptimeResetTimer = undefined;
    }
  }

  private canAutoRestart(): boolean {
    return !this.disposed && !this.intentionalStop;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
