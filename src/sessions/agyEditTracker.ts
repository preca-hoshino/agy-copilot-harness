import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import * as vscodeApi from 'vscode';
import type { AcpToolCallUpdatePayload } from '../acp/acpTypes.js';
import type { AcpBackendInterface } from '../shared/contracts.js';
import { isPathInsideOrEqual } from './agySessionController.js';

export const AGY_BEFORE_QUERY_PARAM = '__agy_before';

const INTERNAL_GEMINI_DIRS = new Set([
  'brain',
  'conversations',
  'annotations',
  'daemon',
  'implicit',
  'cache',
  'scratch',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeComparisonPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toFsPath(filePathOrUri: string): string {
  const trimmed = filePathOrUri.trim();
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return vscodeApi.Uri.parse(trimmed).fsPath;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function toFileUri(filePathOrUri: string): vscode.Uri {
  const trimmed = filePathOrUri.trim();
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return vscodeApi.Uri.parse(trimmed);
    } catch {
      return vscodeApi.Uri.file(trimmed);
    }
  }
  return vscodeApi.Uri.file(trimmed);
}

export function attachAgyBeforeQuery(uri: vscode.Uri, beforeUri: vscode.Uri): vscode.Uri {
  if (typeof uri.with !== 'function') {
    return uri;
  }
  const encoded = `${AGY_BEFORE_QUERY_PARAM}=${encodeURIComponent(beforeUri.toString())}`;
  const existing = typeof uri.query === 'string' ? uri.query : '';
  const cleaned = existing
    .split('&')
    .filter((segment) => segment.length > 0 && !segment.startsWith(`${AGY_BEFORE_QUERY_PARAM}=`));
  cleaned.push(encoded);
  return uri.with({ query: cleaned.join('&') });
}

export function stripAgyBeforeQuery(uri: vscode.Uri): vscode.Uri {
  if (typeof uri.query !== 'string' || uri.query.length === 0 || typeof uri.with !== 'function') {
    return uri;
  }
  const kept = uri.query
    .split('&')
    .filter((segment) => segment.length > 0 && !segment.startsWith(`${AGY_BEFORE_QUERY_PARAM}=`));
  return uri.with({ query: kept.join('&') });
}

export function isInternalAntigravityPath(filePath: string, appDataDir?: string): boolean {
  const fsPath = toFsPath(filePath);
  if (fsPath.length === 0) {
    return false;
  }

  const normalizedResolved = normalizeComparisonPath(path.resolve(fsPath));
  const homeDir = os.homedir();
  const geminiRoot = path.join(homeDir, '.gemini');

  if (appDataDir !== undefined && appDataDir.trim().length > 0) {
    const configuredRoot = path.isAbsolute(appDataDir) ? appDataDir : path.join(geminiRoot, appDataDir.trim());
    if (isPathInsideOrEqual(normalizedResolved, path.resolve(configuredRoot))) {
      return true;
    }
  }

  const defaultAgyRoot = path.resolve(path.join(geminiRoot, 'antigravity'));
  if (isPathInsideOrEqual(normalizedResolved, defaultAgyRoot)) {
    return true;
  }

  const copilotStateRoot = path.resolve(path.join(homeDir, '.copilot', 'session-state'));
  if (isPathInsideOrEqual(normalizedResolved, copilotStateRoot)) {
    return true;
  }

  const forwardSegments = normalizedResolved.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < forwardSegments.length - 2; i += 1) {
    if (forwardSegments[i] === '.gemini' && INTERNAL_GEMINI_DIRS.has(forwardSegments[i + 2] ?? '')) {
      return true;
    }
  }
  return false;
}

export function isWorkspaceTrackedPath(
  filePath: string,
  sessionCwd: string | undefined,
  workspaceFolderPaths: readonly string[],
  appDataDir?: string,
): boolean {
  const fsPath = toFsPath(filePath);
  if (fsPath.length === 0 || isInternalAntigravityPath(fsPath, appDataDir)) {
    return false;
  }
  const resolvedCandidate = path.resolve(fsPath);
  if (
    sessionCwd !== undefined &&
    sessionCwd.length > 0 &&
    isPathInsideOrEqual(resolvedCandidate, path.resolve(sessionCwd))
  ) {
    return true;
  }
  for (const folderPath of workspaceFolderPaths) {
    if (folderPath.length > 0 && isPathInsideOrEqual(resolvedCandidate, path.resolve(folderPath))) {
      return true;
    }
  }
  return false;
}

function getStringField(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

export function extractEditTargetPaths(merged: AcpToolCallUpdatePayload): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (candidate: string | undefined): void => {
    if (candidate === undefined || candidate.trim().length === 0) {
      return;
    }
    const key = normalizeComparisonPath(toFsPath(candidate));
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    paths.push(candidate.trim());
  };

  if (Array.isArray(merged.content)) {
    for (const block of merged.content) {
      if (block.type === 'diff' && typeof block.path === 'string') {
        addPath(block.path);
      }
    }
  }

  const args = isRecord(merged.args) ? merged.args : undefined;
  const rawInput = isRecord(merged.rawInput) ? merged.rawInput : undefined;
  const pathKeys = [
    'TargetFile',
    'Path',
    'path',
    'file_path',
    'filePath',
    'AbsolutePath',
    'absolutePath',
    'file',
    'uri',
  ];
  addPath(getStringField(args, pathKeys) ?? getStringField(rawInput, pathKeys));

  if (paths.length === 0 && Array.isArray(merged.locations)) {
    for (const loc of merged.locations) {
      addPath(loc.path);
    }
  }
  return paths;
}

export function reconstructBeforeContent(
  currentDiskContent: string | undefined,
  merged: AcpToolCallUpdatePayload,
  targetPath?: string,
): string | undefined {
  if (Array.isArray(merged.content)) {
    for (const block of merged.content) {
      if (block.type !== 'diff') {
        continue;
      }
      if (
        targetPath !== undefined &&
        typeof block.path === 'string' &&
        normalizeComparisonPath(toFsPath(block.path)) !== normalizeComparisonPath(toFsPath(targetPath))
      ) {
        continue;
      }
      const oldText = typeof block.oldText === 'string' ? block.oldText : undefined;
      const newText = typeof block.newText === 'string' ? block.newText : undefined;
      if (oldText !== undefined) {
        if (currentDiskContent === undefined || currentDiskContent === newText) {
          return oldText;
        }
        if (newText !== undefined && newText.length > 0 && currentDiskContent.includes(newText)) {
          return currentDiskContent.replace(newText, oldText);
        }
        return oldText;
      }
    }
  }

  const args = isRecord(merged.args) ? merged.args : undefined;
  const rawInput = isRecord(merged.rawInput) ? merged.rawInput : undefined;
  const inputRecord = rawInput ?? args;

  const targetContent =
    getStringField(args, ['Target', 'TargetContent', 'targetContent', 'old_string', 'oldText']) ??
    getStringField(rawInput, ['Target', 'TargetContent', 'targetContent', 'old_string', 'oldText']);
  const replacementContent =
    getStringField(args, ['Replacement', 'ReplacementContent', 'replacementContent', 'new_string', 'newText']) ??
    getStringField(rawInput, ['Replacement', 'ReplacementContent', 'replacementContent', 'new_string', 'newText']);

  if (targetContent !== undefined && replacementContent !== undefined) {
    if (currentDiskContent === undefined) {
      return targetContent;
    }
    if (
      replacementContent.length > 0 &&
      currentDiskContent.includes(replacementContent) &&
      !currentDiskContent.includes(targetContent)
    ) {
      return currentDiskContent.replace(replacementContent, targetContent);
    }
  }

  const chunksRaw: unknown = inputRecord?.ReplacementChunks;
  if (Array.isArray(chunksRaw) && currentDiskContent !== undefined) {
    let reconstructed = currentDiskContent;
    let changed = false;
    for (let i = chunksRaw.length - 1; i >= 0; i -= 1) {
      const chunk: unknown = chunksRaw[i];
      if (!isRecord(chunk)) {
        continue;
      }
      const chunkTarget = getStringField(chunk, ['TargetContent', 'targetContent', 'Target', 'oldText']);
      const chunkReplacement = getStringField(chunk, [
        'ReplacementContent',
        'replacementContent',
        'Replacement',
        'newText',
      ]);
      if (
        chunkTarget !== undefined &&
        chunkReplacement !== undefined &&
        chunkReplacement.length > 0 &&
        reconstructed.includes(chunkReplacement)
      ) {
        reconstructed = reconstructed.replace(chunkReplacement, chunkTarget);
        changed = true;
      }
    }
    if (changed) {
      return reconstructed;
    }
  }

  const normalizedName = (merged.name ?? '').toLowerCase();
  const overwriteFlag = inputRecord?.Overwrite ?? inputRecord?.overwrite;
  if (
    (normalizedName.includes('write') || normalizedName.includes('create')) &&
    overwriteFlag !== true &&
    targetContent === undefined
  ) {
    return '';
  }

  return undefined;
}

async function readFileUtf8Safe(fsPath: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(fsPath, 'utf8');
  } catch {
    return undefined;
  }
}

export interface AgyEditTrackerOptions {
  sessionId: string;
  sessionCwd?: string | undefined;
  appDataDir?: string | undefined;
  workspaceFolderPaths?: readonly string[] | undefined;
  backend?: AcpBackendInterface | undefined;
  startExternalEdit: (uri: vscode.Uri, write: () => Promise<void>, onTracked: () => void) => Promise<void>;
  outputChannel?: vscode.OutputChannel | undefined;
}

export class AgyEditTracker {
  private readonly sessionId: string;
  private readonly sessionCwd: string | undefined;
  private readonly appDataDir: string | undefined;
  private readonly explicitWorkspaceFolderPaths: readonly string[] | undefined;
  private readonly backend: AcpBackendInterface | undefined;
  private readonly startExternalEdit: (
    uri: vscode.Uri,
    write: () => Promise<void>,
    onTracked: () => void,
  ) => Promise<void>;
  private readonly outputChannel: vscode.OutputChannel | undefined;

  private readonly preToolDiskSnapshot = new Map<string, string | null>();
  private readonly trackedCompletedToolIds = new Set<string>();
  private readonly externallyHandledPaths = new Set<string>();
  private readonly fileQueues = new Map<string, Promise<void>>();
  private readonly pendingTasks = new Set<Promise<void>>();

  public constructor(options: AgyEditTrackerOptions) {
    this.sessionId = options.sessionId;
    this.sessionCwd = options.sessionCwd;
    this.appDataDir = options.appDataDir;
    this.explicitWorkspaceFolderPaths = options.workspaceFolderPaths;
    this.backend = options.backend;
    this.startExternalEdit = options.startExternalEdit;
    this.outputChannel = options.outputChannel;
  }

  public shouldTrackInWorkingSet(filePath: string): boolean {
    return isWorkspaceTrackedPath(filePath, this.sessionCwd, this.getWorkspaceFolders(), this.appDataDir);
  }

  public markFileWriteHandled(uri: vscode.Uri): void {
    this.externallyHandledPaths.add(normalizeComparisonPath(uri.fsPath));
  }

  public handleToolCallUpdate(merged: AcpToolCallUpdatePayload): void {
    const targetPaths = extractEditTargetPaths(merged);
    if (targetPaths.length === 0) {
      return;
    }

    for (const targetPath of targetPaths) {
      if (!this.shouldTrackInWorkingSet(targetPath)) {
        continue;
      }
      const fsPath = toFsPath(targetPath);
      const pathKey = normalizeComparisonPath(fsPath);

      if (merged.status !== 'completed' && merged.status !== 'failed') {
        this.enqueueFileTask(pathKey, async () => {
          if (!this.preToolDiskSnapshot.has(`${merged.toolCallId}::${pathKey}`)) {
            const disk = await readFileUtf8Safe(fsPath);
            this.preToolDiskSnapshot.set(`${merged.toolCallId}::${pathKey}`, disk ?? null);
          }
        });
        continue;
      }

      if (merged.status === 'completed') {
        const completionKey = `${merged.toolCallId}::${pathKey}`;
        if (this.trackedCompletedToolIds.has(completionKey)) {
          continue;
        }
        this.trackedCompletedToolIds.add(completionKey);
        this.enqueueFileTask(pathKey, async () => {
          await this.recordCompletedWorkspaceEdit(merged, targetPath, fsPath, pathKey);
        });
      }
    }
  }

  public async flush(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled(Array.from(this.pendingTasks));
    }
  }

  private getWorkspaceFolders(): readonly string[] {
    if (this.explicitWorkspaceFolderPaths !== undefined) {
      return this.explicitWorkspaceFolderPaths;
    }
    const workspaceFolders = (vscodeApi.workspace as Partial<typeof vscodeApi.workspace>).workspaceFolders ?? [];
    return workspaceFolders.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  }

  private enqueueFileTask(pathKey: string, task: () => Promise<void>): void {
    const previous = this.fileQueues.get(pathKey) ?? Promise.resolve();
    const next = previous.then(task, task).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      this.outputChannel?.appendLine(`[AgyEditTracker] Edit tracking failed for ${pathKey}: ${msg}`);
    });
    this.fileQueues.set(pathKey, next);
    this.pendingTasks.add(next);
    void next.finally(() => {
      this.pendingTasks.delete(next);
    });
  }

  private async recordCompletedWorkspaceEdit(
    merged: AcpToolCallUpdatePayload,
    rawTargetPath: string,
    fsPath: string,
    pathKey: string,
  ): Promise<void> {
    if (this.externallyHandledPaths.delete(pathKey)) {
      return;
    }

    const afterDisk = await readFileUtf8Safe(fsPath);
    const snapshotKey = `${merged.toolCallId}::${pathKey}`;
    const capturedPreDisk = this.preToolDiskSnapshot.get(snapshotKey);
    this.preToolDiskSnapshot.delete(snapshotKey);

    let beforeContent: string | undefined;
    if (capturedPreDisk !== undefined && capturedPreDisk !== (afterDisk ?? null)) {
      beforeContent = capturedPreDisk ?? '';
    } else {
      beforeContent = reconstructBeforeContent(afterDisk, merged, rawTargetPath);
      if (beforeContent === undefined && this.backend?.getTurnFileDiff !== undefined) {
        const diff = await this.backend.getTurnFileDiff(this.sessionId, toFileUri(rawTargetPath).toString());
        beforeContent = diff?.originalContent;
      }
      if (beforeContent === undefined && capturedPreDisk === null) {
        beforeContent = '';
      }
    }

    const fileUri = toFileUri(rawTargetPath);
    if (beforeContent === undefined) {
      return;
    }

    const tempDir = path.join(os.tmpdir(), 'agy-edit-baselines');
    await fsPromises.mkdir(tempDir, { recursive: true });
    const hash = createHash('sha1')
      .update(`${this.sessionId}:${merged.toolCallId}:${pathKey}`)
      .digest('hex')
      .slice(0, 12);
    const tempBaselinePath = path.join(tempDir, `${hash}-${path.basename(fsPath)}.tmp`);

    try {
      await fsPromises.writeFile(tempBaselinePath, beforeContent, 'utf8');
      const uriWithBaseline = attachAgyBeforeQuery(fileUri, vscodeApi.Uri.file(tempBaselinePath));
      await this.startExternalEdit(
        uriWithBaseline,
        async () => {
          // File was already updated on disk by Antigravity tool execution; baseline snapshot carries before-state.
          await Promise.resolve();
        },
        () => {
          /* tracked callback handled synchronously by LiveStreamAdapter */
        },
      );
    } finally {
      await fsPromises.unlink(tempBaselinePath).catch(() => {
        /* ignore cleanup error */
      });
    }
  }
}
