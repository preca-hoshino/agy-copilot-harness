import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileWriteHandler, PermissionPrompt } from '../shared/contracts.js';
import type { AcpPermissionOption, AcpRequestPermissionParams } from './acpTypes.js';
import { JsonRpcError } from './jsonRpcTransport.js';

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const PERMISSION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

export interface TerminalEnvEntry {
  name: string;
  value: string;
}

export interface TerminalCreateParams {
  sessionId?: string | undefined;
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  env?: TerminalEnvEntry[] | Record<string, string> | undefined;
  outputByteLimit?: number | undefined;
}

export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
}

export interface AgyTerminalManagerOptions {
  mirrorTerminals?: boolean | undefined;
}

export type PermissionOutcomeResult =
  | {
      outcome: {
        outcome: 'selected';
        optionId: string;
      };
    }
  | {
      outcome: {
        outcome: 'cancelled';
      };
    };

interface ManagedTerminal {
  readonly id: string;
  readonly command: string;
  readonly process: ChildProcess;
  readonly outputByteLimit: number;
  outputBuffer: Buffer;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  readonly exitPromise: Promise<TerminalExitStatus>;
  readonly resolveExit: (status: TerminalExitStatus) => void;
  mirroredTerminal: vscode.Terminal | undefined;
  writeEmitter: vscode.EventEmitter<string> | undefined;
  closeEmitter: vscode.EventEmitter<number> | undefined;
  ptyOpened: boolean;
  pendingPtyText: string;
}

interface PermissionQuickPickItem extends vscode.QuickPickItem {
  optionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRequiredString(record: Record<string, unknown>, key: string): string {
  const val = record[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new JsonRpcError(-32602, `Invalid or missing string parameter "${key}"`);
  }
  return val;
}

function getOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const val = record[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new JsonRpcError(-32602, `Invalid numeric parameter "${key}"`);
  }
  return val;
}

function appendWithByteLimit(
  existing: Buffer,
  chunk: Buffer,
  byteLimit: number,
): { buffer: Buffer; truncated: boolean } {
  const combined = Buffer.concat([existing, chunk]);
  if (combined.length <= byteLimit) {
    return { buffer: combined, truncated: false };
  }

  let start = combined.length - byteLimit;
  while (start < combined.length) {
    const byte = combined[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return { buffer: combined.subarray(start), truncated: true };
}

function normalizePtyText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function parseTerminalEnv(rawEnv: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(rawEnv)) {
    for (const item of rawEnv) {
      if (isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string') {
        result[item.name] = item.value;
      }
    }
    return result;
  }
  if (isRecord(rawEnv)) {
    for (const [key, val] of Object.entries(rawEnv)) {
      if (typeof val === 'string') {
        result[key] = val;
      }
    }
  }
  return result;
}

function parseTerminalCreateParams(params: unknown): TerminalCreateParams {
  if (!isRecord(params)) {
    throw new JsonRpcError(-32602, 'Invalid params for terminal/create');
  }
  const command = getRequiredString(params, 'command');
  const args: string[] = [];
  if (Array.isArray(params.args)) {
    for (const item of params.args) {
      if (typeof item === 'string') {
        args.push(item);
      }
    }
  }
  const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
  const outputByteLimit = getOptionalNumber(params, 'outputByteLimit');

  let env: TerminalEnvEntry[] | Record<string, string> | undefined;
  if (params.env !== undefined && params.env !== null) {
    env = parseTerminalEnv(params.env);
  }

  return {
    sessionId,
    command,
    args,
    cwd,
    env,
    outputByteLimit,
  };
}

function parseTerminalId(params: unknown): string {
  if (!isRecord(params)) {
    throw new JsonRpcError(-32602, 'Invalid params: expected object with terminalId');
  }
  return getRequiredString(params, 'terminalId');
}

function parsePermissionOptions(rawOptions: unknown): AcpPermissionOption[] {
  if (!Array.isArray(rawOptions)) {
    throw new JsonRpcError(-32602, 'Invalid params: options must be an array');
  }
  const options: AcpPermissionOption[] = [];
  const ids = new Set<string>();
  for (const item of rawOptions) {
    if (
      isRecord(item) &&
      typeof item.optionId === 'string' &&
      item.optionId.length > 0 &&
      typeof item.name === 'string' &&
      typeof item.kind === 'string' &&
      PERMISSION_KINDS.has(item.kind)
    ) {
      if (ids.has(item.optionId)) {
        throw new JsonRpcError(-32602, 'Invalid params: duplicate permission option ID');
      }
      ids.add(item.optionId);
      options.push({
        optionId: item.optionId,
        name: item.name,
        kind: item.kind,
      });
    }
  }
  return options;
}

function parseRequestPermissionParams(params: unknown): AcpRequestPermissionParams {
  if (!isRecord(params)) {
    throw new JsonRpcError(-32602, 'Invalid params for session/request_permission');
  }
  const sessionId = getRequiredString(params, 'sessionId');
  if (!isRecord(params.toolCall)) {
    throw new JsonRpcError(-32602, 'Invalid params: missing toolCall');
  }
  const toolCallRecord = params.toolCall;
  const toolCallId = getRequiredString(toolCallRecord, 'toolCallId');

  return {
    sessionId,
    toolCall: {
      toolCallId,
      title: typeof toolCallRecord.title === 'string' ? toolCallRecord.title : undefined,
      name: typeof toolCallRecord.name === 'string' ? toolCallRecord.name : undefined,
      kind: typeof toolCallRecord.kind === 'string' ? toolCallRecord.kind : undefined,
      rawInput: isRecord(toolCallRecord.rawInput)
        ? toolCallRecord.rawInput
        : isRecord(toolCallRecord.args)
          ? toolCallRecord.args
          : undefined,
    },
    options: parsePermissionOptions(params.options),
  };
}

function sliceLines(text: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) {
    return text;
  }
  const lines = text.split('\n');
  const startIndex = line !== undefined ? Math.max(0, Math.floor(line) - 1) : 0;
  if (limit !== undefined) {
    const count = Math.max(0, Math.floor(limit));
    return lines.slice(startIndex, startIndex + count).join('\n');
  }
  return lines.slice(startIndex).join('\n');
}

export class AgyTerminalManager implements vscode.Disposable {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly outputChannel: vscode.OutputChannel | undefined;
  private readonly mirrorOverride: boolean | undefined;

  public constructor(outputChannel?: vscode.OutputChannel, options?: AgyTerminalManagerOptions) {
    this.outputChannel = outputChannel;
    this.mirrorOverride = options?.mirrorTerminals;
  }

  public createTerminal(params: TerminalCreateParams): { terminalId: string } {
    const terminalId = randomUUID();
    const defaultCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const cwd = params.cwd !== undefined && params.cwd.length > 0 ? params.cwd : defaultCwd;
    const envAdditions = params.env !== undefined ? parseTerminalEnv(params.env) : {};
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...envAdditions };
    const args = params.args ?? [];
    const useShell = args.length === 0;
    const outputByteLimit =
      params.outputByteLimit !== undefined && params.outputByteLimit > 0
        ? Math.floor(params.outputByteLimit)
        : DEFAULT_OUTPUT_BYTE_LIMIT;

    const child = spawn(params.command, args, {
      cwd,
      env: mergedEnv,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let resolveExitFn: (status: TerminalExitStatus) => void = () => {
      /* initialized synchronously in Promise constructor */
    };
    const exitPromise = new Promise<TerminalExitStatus>((resolve) => {
      resolveExitFn = resolve;
    });

    const entry: ManagedTerminal = {
      id: terminalId,
      command: params.command,
      process: child,
      outputByteLimit,
      outputBuffer: Buffer.alloc(0),
      truncated: false,
      exitStatus: null,
      exitPromise,
      resolveExit: resolveExitFn,
      mirroredTerminal: undefined,
      writeEmitter: undefined,
      closeEmitter: undefined,
      ptyOpened: false,
      pendingPtyText: '',
    };

    if (this.shouldMirrorTerminals()) {
      this.attachMirroredPseudoterminal(entry);
    }

    const appendOutput = (chunk: Buffer): void => {
      const updated = appendWithByteLimit(entry.outputBuffer, chunk, entry.outputByteLimit);
      entry.outputBuffer = updated.buffer;
      if (updated.truncated) {
        entry.truncated = true;
      }

      if (entry.writeEmitter !== undefined) {
        const text = normalizePtyText(chunk.toString('utf8'));
        if (entry.ptyOpened) {
          entry.writeEmitter.fire(text);
        } else {
          entry.pendingPtyText += text;
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      appendOutput(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput(chunk);
    });

    const finalizeExit = (exitCode: number | null, signal: string | null): void => {
      if (entry.exitStatus !== null) {
        return;
      }
      const status: TerminalExitStatus = { exitCode, signal };
      entry.exitStatus = status;
      entry.resolveExit(status);
      entry.closeEmitter?.fire(exitCode ?? 0);
    };

    child.on('error', (err: Error) => {
      this.outputChannel?.appendLine(`[Terminal ${terminalId}] Spawn error: ${err.message}`);
      appendOutput(Buffer.from(`[spawn error: ${err.message}]\n`, 'utf8'));
      if (child.pid === undefined) {
        finalizeExit(1, null);
      }
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finalizeExit(code, signal);
    });

    this.terminals.set(terminalId, entry);
    return { terminalId };
  }

  public getOutput(terminalId: string): TerminalOutputResult {
    const entry = this.requireTerminal(terminalId);
    return {
      output: entry.outputBuffer.toString('utf8'),
      truncated: entry.truncated,
      exitStatus: entry.exitStatus,
    };
  }

  public async waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const entry = this.requireTerminal(terminalId);
    if (entry.exitStatus !== null) {
      return entry.exitStatus;
    }
    return await entry.exitPromise;
  }

  public kill(terminalId: string): Record<string, never> {
    const entry = this.requireTerminal(terminalId);
    if (entry.exitStatus === null) {
      entry.process.kill();
    }
    return {};
  }

  public release(terminalId: string): Record<string, never> {
    const entry = this.requireTerminal(terminalId);
    if (entry.exitStatus === null) {
      entry.process.kill();
    }
    this.cleanupMirroredTerminal(entry);
    this.terminals.delete(terminalId);
    return {};
  }

  public dispose(): void {
    for (const entry of this.terminals.values()) {
      if (entry.exitStatus === null) {
        entry.process.kill();
      }
      this.cleanupMirroredTerminal(entry);
    }
    this.terminals.clear();
  }

  private requireTerminal(terminalId: string): ManagedTerminal {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) {
      throw new JsonRpcError(-32602, `Unknown terminalId: ${terminalId}`);
    }
    return entry;
  }

  private shouldMirrorTerminals(): boolean {
    if (this.mirrorOverride !== undefined) {
      return this.mirrorOverride;
    }
    return vscode.workspace.getConfiguration('antigravityHarness').get<boolean>('mirrorTerminals') ?? false;
  }

  private attachMirroredPseudoterminal(entry: ManagedTerminal): void {
    try {
      const writeEmitter = new vscode.EventEmitter<string>();
      const closeEmitter = new vscode.EventEmitter<number>();
      entry.writeEmitter = writeEmitter;
      entry.closeEmitter = closeEmitter;

      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: (): void => {
          entry.ptyOpened = true;
          if (entry.pendingPtyText.length > 0) {
            writeEmitter.fire(entry.pendingPtyText);
            entry.pendingPtyText = '';
          }
          if (entry.exitStatus !== null) {
            closeEmitter.fire(entry.exitStatus.exitCode ?? 0);
          }
        },
        close: (): void => {
          if (entry.exitStatus === null) {
            entry.process.kill();
          }
        },
      };

      entry.mirroredTerminal = vscode.window.createTerminal({
        name: `Agy: ${entry.command}`,
        pty,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel?.appendLine(`[Terminal ${entry.id}] Failed to mirror terminal: ${message}`);
    }
  }

  private cleanupMirroredTerminal(entry: ManagedTerminal): void {
    entry.mirroredTerminal?.dispose();
    entry.writeEmitter?.dispose();
    entry.closeEmitter?.dispose();
    entry.mirroredTerminal = undefined;
    entry.writeEmitter = undefined;
    entry.closeEmitter = undefined;
  }
}

export class ClientCapabilitiesHandler implements vscode.Disposable {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly terminalManager: AgyTerminalManager;
  private readonly sessionModes = new Map<string, string>();
  private readonly permissionPrompts = new Map<string, PermissionPrompt>();
  private readonly fileWriteHandlers = new Map<string, FileWriteHandler>();

  public constructor(outputChannel: vscode.OutputChannel, terminalManager?: AgyTerminalManager) {
    this.outputChannel = outputChannel;
    this.terminalManager = terminalManager ?? new AgyTerminalManager(outputChannel);
  }

  public setSessionMode(sessionId: string, mode: string): void {
    this.sessionModes.set(sessionId, mode);
  }

  public getSessionMode(sessionId: string): string | undefined {
    return this.sessionModes.get(sessionId);
  }

  public registerPermissionPrompt(sessionId: string, prompt: PermissionPrompt): vscode.Disposable {
    this.permissionPrompts.set(sessionId, prompt);
    return new vscode.Disposable(() => {
      if (this.permissionPrompts.get(sessionId) === prompt) {
        this.permissionPrompts.delete(sessionId);
      }
    });
  }

  public registerFileWriteHandler(sessionId: string, handler: FileWriteHandler): vscode.Disposable {
    this.fileWriteHandlers.set(sessionId, handler);
    return new vscode.Disposable(() => {
      if (this.fileWriteHandlers.get(sessionId) === handler) {
        this.fileWriteHandlers.delete(sessionId);
      }
    });
  }

  public async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file':
        return await this.handleReadTextFile(params);
      case 'fs/write_text_file':
        return await this.handleWriteTextFile(params);
      case 'terminal/create':
        return this.terminalManager.createTerminal(parseTerminalCreateParams(params));
      case 'terminal/output':
        return this.terminalManager.getOutput(parseTerminalId(params));
      case 'terminal/wait_for_exit':
        return await this.terminalManager.waitForExit(parseTerminalId(params));
      case 'terminal/kill':
        return this.terminalManager.kill(parseTerminalId(params));
      case 'terminal/release':
        return this.terminalManager.release(parseTerminalId(params));
      case 'session/request_permission':
        return await this.handleRequestPermission(params);
      default:
        throw new JsonRpcError(-32601, `Unsupported ACP client method: ${method}`);
    }
  }

  public dispose(): void {
    this.terminalManager.dispose();
    this.sessionModes.clear();
    this.permissionPrompts.clear();
    this.fileWriteHandlers.clear();
  }

  private async handleReadTextFile(params: unknown): Promise<{ content: string }> {
    if (!isRecord(params)) {
      throw new JsonRpcError(-32602, 'Invalid params for fs/read_text_file');
    }
    const filePath = getRequiredString(params, 'path');
    const line = getOptionalNumber(params, 'line');
    const limit = getOptionalNumber(params, 'limit');

    const targetUri = vscode.Uri.file(filePath);
    const dirtyDoc = vscode.workspace.textDocuments.find((doc) => doc.isDirty && this.urisMatch(doc.uri, targetUri));

    let fullText: string;
    if (dirtyDoc !== undefined) {
      fullText = dirtyDoc.getText();
    } else {
      const bytes = await vscode.workspace.fs.readFile(targetUri);
      fullText = Buffer.from(bytes).toString('utf8');
    }

    return { content: sliceLines(fullText, line, limit) };
  }

  private async handleWriteTextFile(params: unknown): Promise<Record<string, never>> {
    if (!isRecord(params)) {
      throw new JsonRpcError(-32602, 'Invalid params for fs/write_text_file');
    }
    const filePath = getRequiredString(params, 'path');
    if (typeof params.content !== 'string') {
      throw new JsonRpcError(-32602, 'Invalid or missing string parameter "content"');
    }

    const targetUri = vscode.Uri.file(filePath);
    const parentUri = vscode.Uri.file(path.dirname(targetUri.fsPath));
    const content = params.content;
    const write = async (): Promise<void> => {
      if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && this.urisMatch(doc.uri, targetUri))) {
        throw new Error(`Cannot write ${filePath}: the document has unsaved changes.`);
      }
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf8'));
    };
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const handler = sessionId === undefined ? undefined : this.fileWriteHandlers.get(sessionId);
    if (handler === undefined) {
      await write();
    } else {
      await handler(targetUri, write);
    }
    return {};
  }

  private async handleRequestPermission(params: unknown): Promise<PermissionOutcomeResult> {
    const req = parseRequestPermissionParams(params);
    const configuredDefaultMode =
      vscode.workspace.getConfiguration('antigravityHarness').get<string>('defaultMode') ?? 'default';
    const activeMode = this.sessionModes.get(req.sessionId) ?? configuredDefaultMode;

    if (this.shouldAutoApprove(activeMode, req.toolCall)) {
      const allowOption = req.options.find((opt) => opt.kind === 'allow_once');
      if (allowOption !== undefined) {
        this.outputChannel.appendLine(
          `[Permission] Auto-approved (${activeMode}) tool call "${req.toolCall.title ?? req.toolCall.name ?? req.toolCall.toolCallId}" via option "${allowOption.optionId}"`,
        );
        return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
      }
    }

    if (req.options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const prompt = this.permissionPrompts.get(req.sessionId);
    if (prompt !== undefined) {
      const optionId = await prompt(req);
      if (
        this.permissionPrompts.get(req.sessionId) === prompt &&
        req.options.some((option) => option.optionId === optionId) &&
        optionId !== undefined
      ) {
        return { outcome: { outcome: 'selected', optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    const items: PermissionQuickPickItem[] = req.options.map((opt) => ({
      label: opt.name,
      description: opt.kind,
      optionId: opt.optionId,
    }));

    const title = req.toolCall.title ?? req.toolCall.name ?? req.toolCall.toolCallId;
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Antigravity permission request: ${title}`,
      ignoreFocusOut: true,
    });

    if (picked === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }

    return { outcome: { outcome: 'selected', optionId: picked.optionId } };
  }

  private shouldAutoApprove(mode: string, toolCall: AcpRequestPermissionParams['toolCall']): boolean {
    if (mode === 'auto') {
      return true;
    }
    if (mode === 'accept-edits') {
      return this.isEditOrWriteToolCall(toolCall);
    }
    return false;
  }

  private isEditOrWriteToolCall(toolCall: AcpRequestPermissionParams['toolCall']): boolean {
    const kind = toolCall.kind?.toLowerCase();
    if (kind === 'edit' || kind === 'write' || kind === 'delete' || kind === 'move') {
      return true;
    }
    const name = toolCall.name?.toLowerCase() ?? '';
    return (
      name.includes('edit') ||
      name.includes('write') ||
      name === 'replace_file_content' ||
      name === 'multi_replace_file_content'
    );
  }

  private urisMatch(a: vscode.Uri, b: vscode.Uri): boolean {
    if (a.toString() === b.toString()) {
      return true;
    }
    if (process.platform === 'win32') {
      return a.fsPath.toLowerCase() === b.fsPath.toLowerCase();
    }
    return a.fsPath === b.fsPath;
  }
}
