import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpToolCallContentItem, AcpToolCallUpdatePayload } from '../acp/acpTypes.js';
import {
  buildSubagentChatResource,
  extractSubagentCallMetadata,
  isSubagentInvokeCall,
  parseGeneralTranscriptRecord,
  type SubagentCallMetadata,
} from './subagentTranscript.js';

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const VIDEO_EXTS = new Set<string>(['.webm']);

const BROWSER_ACTION_NAMES = new Set<string>([
  'navigate',
  'open_url',
  'goto',
  'click',
  'click_element',
  'type',
  'type_text',
  'input_text',
  'fill',
  'scroll',
  'screenshot',
  'capture_screenshot',
  'press_key',
  'hover',
  'wait',
  'select_option',
  'read_dom',
  'snapshot',
  'evaluate',
  'execute_js',
]);

const NEEDS_INPUT_PATTERN =
  /captcha|recaptcha|hcaptcha|turnstile|verify\s+you\s+are\s+human|human\s+verification|anti-?bot|cloudflare\s+challenge|please\s+log\s*in|login\s+required|sign\s*in\s+required|authentication\s+required|two-factor|\b2fa\b|manual\s+intervention|needs?\s+user\s+input/i;

const POLL_INTERVAL_MS = 250;
const DIR_MTIME_LOOKBACK_MS = 15_000;

interface ParsedMediaAttachment {
  readonly filePath: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

interface ParsedTranscriptStep {
  readonly stepKey: string;
  readonly toolName: string;
  readonly summary: string;
  readonly isComplete: boolean;
  readonly images: ParsedMediaAttachment[];
  readonly webmPaths: string[];
  readonly needsInputReason: string | undefined;
}

interface LiveBrowserCallState {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly isBrowser: boolean;
  role: string;
  readonly typeName: string;
  prompt: string;
  startedAt: number;
  latestTranscriptMs?: number | undefined;
  modelName: string | undefined;
  subagentId: string | undefined;
  deferredInvokeComplete?: boolean | undefined;
  deferredResultText?: string | undefined;
  stream?: Pick<vscode.ChatResponseStream, 'push'> | undefined;
  readonly parentPart: vscode.ChatToolInvocationPart;
  watcher: BrowserTrajectoryWatcher | undefined;
  readonly emittedWebmPaths: Set<string>;
}

export interface SubagentWatcherOptions {
  readonly browserOnly?: boolean | undefined;
  readonly subAgentName?: string | undefined;
  readonly subagentIdHint?: string | undefined;
  readonly onDiscoveredSubagentId?: ((subagentId: string) => void) | undefined;
  readonly onTranscriptMeta?:
    | ((meta: {
        readonly modelName?: string | undefined;
        readonly earliestCreatedAtMs?: number | undefined;
        readonly latestCreatedAtMs?: number | undefined;
        readonly isTerminalAssistantTurn?: boolean | undefined;
      }) => void)
    | undefined;
}

export function openMediaPreviewPanel(mediaPath: string, title?: string): void {
  const panelTitle = title !== undefined && title.length > 0 ? title : path.basename(mediaPath);
  const mediaDir = path.dirname(mediaPath);
  const panel = vscode.window.createWebviewPanel('antigravity.mediaPreview', panelTitle, vscode.ViewColumn.Beside, {
    enableScripts: false,
    localResourceRoots: [vscode.Uri.file(mediaDir)],
  });

  const mediaUri = panel.webview.asWebviewUri(vscode.Uri.file(mediaPath)).toString();
  const ext = path.extname(mediaPath).toLowerCase();
  const escapedTitle = escapeHtml(panelTitle);
  const escapedMediaUri = escapeHtml(mediaUri);
  const csp = [
    "default-src 'none'",
    `img-src ${panel.webview.cspSource}`,
    `media-src ${panel.webview.cspSource}`,
    "style-src 'unsafe-inline'",
  ].join('; ');

  const mediaElement = VIDEO_EXTS.has(ext)
    ? `<video controls autoplay loop playsinline src="${escapedMediaUri}"></video>`
    : `<img src="${escapedMediaUri}" alt="${escapedTitle}" />`;

  panel.webview.html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />`,
    `<title>${escapedTitle}</title>`,
    '<style>',
    'html, body { margin: 0; padding: 16px; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); font-family: var(--vscode-font-family, sans-serif); }',
    '.container { display: flex; flex-direction: column; align-items: center; gap: 12px; }',
    '.caption { font-size: 13px; opacity: 0.85; word-break: break-all; }',
    'video, img { max-width: 100%; max-height: 85vh; border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="container">',
    mediaElement,
    `<div class="caption">${escapeHtml(mediaPath)}</div>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

export class BrowserTrajectoryWatcher {
  private readonly brainRootDir: string;
  private readonly browserOnly: boolean;
  private readonly subAgentName: string;
  private subagentIdHint: string | undefined;
  private readonly onDiscoveredSubagentId: ((subagentId: string) => void) | undefined;
  private readonly onTranscriptMeta:
    | ((meta: {
        readonly modelName?: string | undefined;
        readonly earliestCreatedAtMs?: number | undefined;
        readonly latestCreatedAtMs?: number | undefined;
        readonly isTerminalAssistantTurn?: boolean | undefined;
      }) => void)
    | undefined;
  private parentToolCallId = '';
  private promptHint = '';
  private sessionIdHint: string | undefined;
  private onStepCallback: ((part: vscode.ChatToolInvocationPart) => void) | undefined;
  private onNeedsInputCallback: ((reason: string) => void) | undefined;
  private startedAtMs = 0;
  private stopped = false;
  private matchedSubagentDir: string | undefined;
  private discoveredSubagentId: string | undefined;
  private reportedDiscovery = false;
  private observedModelName: string | undefined;
  private earliestTranscriptMs: number | undefined;
  private latestTranscriptMs: number | undefined;
  private terminalAssistantTurnObserved = false;
  private hasInProgressGeneralStep = false;
  private transcriptFilePath: string | undefined;
  private transcriptByteOffset = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private rootFsWatcher: fs.FSWatcher | undefined;
  private dirFsWatcher: fs.FSWatcher | undefined;
  private stepSequence = 0;
  private readonly emittedStepKeys = new Set<string>();
  private readonly emittedGeneralParts = new Map<string, vscode.ChatToolInvocationPart>();
  private readonly emittedImagePaths = new Set<string>();
  private readonly discoveredWebmPaths = new Set<string>();
  private readonly reportedNeedsInputReasons = new Set<string>();

  public constructor(brainRootDir?: string, options?: SubagentWatcherOptions) {
    this.brainRootDir = brainRootDir ?? path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    this.browserOnly = options?.browserOnly !== false;
    this.subAgentName = options?.subAgentName ?? 'Browser';
    this.subagentIdHint = options?.subagentIdHint;
    this.onDiscoveredSubagentId = options?.onDiscoveredSubagentId;
    this.onTranscriptMeta = options?.onTranscriptMeta;
  }

  public startWatching(
    parentToolCallId: string,
    promptHint: string,
    onStep: (part: vscode.ChatToolInvocationPart) => void,
    onNeedsInput?: (reason: string) => void,
    sessionIdHint?: string,
  ): vscode.Disposable {
    this.stop();
    this.stopped = false;
    this.parentToolCallId = parentToolCallId;
    this.promptHint = promptHint;
    this.sessionIdHint = sessionIdHint;
    this.onStepCallback = onStep;
    this.onNeedsInputCallback = onNeedsInput;
    this.startedAtMs = Date.now();
    this.matchedSubagentDir = undefined;
    this.discoveredSubagentId = undefined;
    this.reportedDiscovery = false;
    this.observedModelName = undefined;
    this.earliestTranscriptMs = undefined;
    this.latestTranscriptMs = undefined;
    this.terminalAssistantTurnObserved = false;
    this.hasInProgressGeneralStep = false;
    this.transcriptFilePath = undefined;
    this.transcriptByteOffset = 0;
    this.stepSequence = 0;
    this.emittedStepKeys.clear();
    this.emittedGeneralParts.clear();
    this.emittedImagePaths.clear();
    this.discoveredWebmPaths.clear();
    this.reportedNeedsInputReasons.clear();

    this.scanOnce(false);
    this.attachWatchers();

    this.pollTimer = setInterval(() => {
      if (!this.stopped) {
        this.scanOnce(false);
      }
    }, POLL_INTERVAL_MS);

    return new vscode.Disposable(() => {
      this.stop();
    });
  }

  public setSubagentIdHint(subagentId: string): void {
    const trimmed = subagentId.trim();
    if (trimmed.length === 0 || this.subagentIdHint === trimmed) {
      return;
    }
    this.subagentIdHint = trimmed;
    if (!this.stopped) {
      this.scanOnce(false);
    }
  }

  public getMatchedSubagentId(): string | undefined {
    return this.discoveredSubagentId ?? this.subagentIdHint;
  }

  public hasTranscriptFile(): boolean {
    return this.transcriptFilePath !== undefined && fs.existsSync(this.transcriptFilePath);
  }

  public hasCompletedAssistantTurn(): boolean {
    return this.terminalAssistantTurnObserved;
  }

  public hasPendingSteps(): boolean {
    return this.hasInProgressGeneralStep;
  }

  public getTranscriptElapsedMs(): number | undefined {
    if (
      this.earliestTranscriptMs !== undefined &&
      this.latestTranscriptMs !== undefined &&
      this.latestTranscriptMs >= this.earliestTranscriptMs
    ) {
      return this.latestTranscriptMs - this.earliestTranscriptMs;
    }
    return undefined;
  }

  public flush(): void {
    if (this.stopped) {
      return;
    }
    this.scanOnce(true);
  }

  public getDiscoveredWebmPaths(): string[] {
    return Array.from(this.discoveredWebmPaths);
  }

  public stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.rootFsWatcher !== undefined) {
      try {
        this.rootFsWatcher.close();
      } catch {
        // Ignore watcher close errors during teardown.
      }
      this.rootFsWatcher = undefined;
    }
    if (this.dirFsWatcher !== undefined) {
      try {
        this.dirFsWatcher.close();
      } catch {
        // Ignore watcher close errors during teardown.
      }
      this.dirFsWatcher = undefined;
    }
    this.onStepCallback = undefined;
    this.onNeedsInputCallback = undefined;
  }

  private attachWatchers(): void {
    if (this.stopped || !fs.existsSync(this.brainRootDir)) {
      return;
    }
    try {
      this.rootFsWatcher = fs.watch(this.brainRootDir, () => {
        if (!this.stopped) {
          this.scanOnce(false);
        }
      });
    } catch {
      // Polling fallback continues even if fs.watch fails on platform/path.
    }
  }

  private attachSubagentDirWatcher(dirPath: string): void {
    if (this.stopped || this.dirFsWatcher !== undefined || !fs.existsSync(dirPath)) {
      return;
    }
    try {
      this.dirFsWatcher = fs.watch(dirPath, () => {
        if (!this.stopped) {
          this.scanOnce(false);
        }
      });
    } catch {
      // Polling handles updates if directory watching is unavailable.
    }
  }

  private scanOnce(flushTrailingLine: boolean): void {
    if (this.stopped) {
      return;
    }

    if (this.matchedSubagentDir === undefined) {
      this.matchedSubagentDir = this.discoverMatchingDir();
      if (this.matchedSubagentDir !== undefined) {
        const dirName = path.basename(this.matchedSubagentDir);
        if (dirName.length > 0 && (this.subagentIdHint === dirName || dirName !== this.sessionIdHint)) {
          this.discoveredSubagentId = dirName;
          if (!this.reportedDiscovery) {
            this.reportedDiscovery = true;
            this.onDiscoveredSubagentId?.(dirName);
          }
        }
        this.attachSubagentDirWatcher(this.matchedSubagentDir);
      }
    }

    const dirsToScan = this.collectDirsToScan();
    for (const dirPath of dirsToScan) {
      this.tailTranscriptInDir(dirPath, flushTrailingLine);
      if (this.browserOnly) {
        this.scanMediaFilesInDir(dirPath);
      }
    }
  }

  private collectDirsToScan(): string[] {
    const dirs: string[] = [];
    if (this.matchedSubagentDir !== undefined && fs.existsSync(this.matchedSubagentDir)) {
      dirs.push(this.matchedSubagentDir);
    }
    if (this.subagentIdHint !== undefined && this.subagentIdHint.length > 0) {
      const hintDir = path.join(this.brainRootDir, this.subagentIdHint);
      if (fs.existsSync(hintDir) && !dirs.includes(hintDir)) {
        dirs.push(hintDir);
      }
    }
    if (this.browserOnly && this.sessionIdHint !== undefined && this.sessionIdHint.length > 0) {
      const sessionDir = path.join(this.brainRootDir, this.sessionIdHint);
      if (fs.existsSync(sessionDir) && !dirs.includes(sessionDir)) {
        dirs.push(sessionDir);
      }
    }
    return dirs;
  }

  private discoverMatchingDir(): string | undefined {
    if (!fs.existsSync(this.brainRootDir)) {
      return undefined;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.brainRootDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    const subdirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (subdirs.length === 0) {
      return undefined;
    }

    if (this.subagentIdHint !== undefined && subdirs.includes(this.subagentIdHint)) {
      return path.join(this.brainRootDir, this.subagentIdHint);
    }

    if (subdirs.includes(this.parentToolCallId)) {
      return path.join(this.brainRootDir, this.parentToolCallId);
    }

    const normalizedHint = normalizePromptSnippet(this.promptHint);
    const candidates: Array<{ readonly dirPath: string; readonly mtimeMs: number; readonly hasContent: boolean }> = [];

    for (const name of subdirs) {
      if (!this.browserOnly && name === this.sessionIdHint) {
        continue;
      }
      const dirPath = path.join(this.brainRootDir, name);
      const transcriptPath = getTranscriptPath(dirPath);
      const hasTranscript = fs.existsSync(transcriptPath);
      if (hasTranscript && normalizedHint.length > 0 && transcriptMatchesPrompt(transcriptPath, normalizedHint)) {
        return dirPath;
      }

      const dirMtime = safeStatMtimeMs(hasTranscript ? transcriptPath : dirPath);
      const hasMedia = this.browserOnly && listBrowserMediaFiles(dirPath).length > 0;
      if (hasTranscript || hasMedia) {
        candidates.push({ dirPath, mtimeMs: dirMtime, hasContent: true });
      }
    }

    if (this.browserOnly && this.sessionIdHint !== undefined && subdirs.includes(this.sessionIdHint)) {
      return path.join(this.brainRootDir, this.sessionIdHint);
    }

    const recentCandidates = candidates
      .filter((item) => item.mtimeMs >= this.startedAtMs - DIR_MTIME_LOOKBACK_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (recentCandidates[0] !== undefined) {
      return recentCandidates[0].dirPath;
    }

    if (candidates.length === 1 && candidates[0]?.hasContent === true) {
      return candidates[0].dirPath;
    }

    return undefined;
  }

  private tailTranscriptInDir(dirPath: string, flushTrailingLine: boolean): void {
    const transcriptPath = getTranscriptPath(dirPath);
    if (!fs.existsSync(transcriptPath)) {
      return;
    }

    if (this.transcriptFilePath !== undefined && this.transcriptFilePath !== transcriptPath) {
      return;
    }
    this.transcriptFilePath = transcriptPath;

    let fileBuffer: Buffer;
    try {
      fileBuffer = fs.readFileSync(transcriptPath);
    } catch {
      return;
    }

    if (fileBuffer.length <= this.transcriptByteOffset) {
      return;
    }

    const slice = fileBuffer.subarray(this.transcriptByteOffset);
    const chunkText = slice.toString('utf8');
    const lastNewlineIdx = chunkText.lastIndexOf('\n');

    let consumableText: string;
    let bytesConsumed: number;

    if (lastNewlineIdx >= 0) {
      const trailingText = chunkText.slice(lastNewlineIdx + 1).trim();
      if (trailingText.length > 0 && (flushTrailingLine || isCompleteJsonLine(trailingText))) {
        consumableText = chunkText;
        bytesConsumed = slice.length;
      } else {
        consumableText = chunkText.slice(0, lastNewlineIdx + 1);
        bytesConsumed = Buffer.byteLength(consumableText, 'utf8');
      }
    } else if (flushTrailingLine || isCompleteJsonLine(chunkText.trim())) {
      consumableText = chunkText;
      bytesConsumed = slice.length;
    } else {
      return;
    }

    this.transcriptByteOffset += bytesConsumed;

    const lines = consumableText.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (this.browserOnly) {
        const steps = parseTranscriptJsonLine(trimmed, dirPath, () => {
          this.stepSequence += 1;
          return this.stepSequence;
        });
        for (const step of steps) {
          this.emitParsedStep(step);
        }
      } else {
        this.consumeGeneralTranscriptLine(trimmed);
      }
    }
  }

  private consumeGeneralTranscriptLine(trimmedLine: string): void {
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(trimmedLine) as unknown;
    } catch {
      return;
    }
    if (!isRecord(rawParsed)) {
      return;
    }
    const rawCreatedAt =
      typeof rawParsed.created_at === 'string'
        ? rawParsed.created_at
        : typeof rawParsed.createdAt === 'string'
          ? rawParsed.createdAt
          : typeof rawParsed.timestamp === 'string'
            ? rawParsed.timestamp
            : undefined;
    const rawCreatedAtMs = rawCreatedAt !== undefined ? Date.parse(rawCreatedAt) : Number.NaN;
    if (Number.isFinite(rawCreatedAtMs)) {
      let timeMetaChanged = false;
      if (this.earliestTranscriptMs === undefined || rawCreatedAtMs < this.earliestTranscriptMs) {
        this.earliestTranscriptMs = rawCreatedAtMs;
        timeMetaChanged = true;
      }
      if (this.latestTranscriptMs === undefined || rawCreatedAtMs > this.latestTranscriptMs) {
        this.latestTranscriptMs = rawCreatedAtMs;
        timeMetaChanged = true;
      }
      if (timeMetaChanged) {
        this.onTranscriptMeta?.({
          modelName: this.observedModelName,
          earliestCreatedAtMs: this.earliestTranscriptMs,
          latestCreatedAtMs: this.latestTranscriptMs,
          isTerminalAssistantTurn: this.terminalAssistantTurnObserved,
        });
      }
    }
    const steps = parseGeneralTranscriptRecord(rawParsed, () => {
      this.stepSequence += 1;
      return this.stepSequence;
    });
    for (const step of steps) {
      let metaChanged = false;
      if (step.modelName !== undefined && step.modelName !== this.observedModelName) {
        this.observedModelName = step.modelName;
        metaChanged = true;
      }
      if (step.createdAtMs !== undefined) {
        if (this.earliestTranscriptMs === undefined || step.createdAtMs < this.earliestTranscriptMs) {
          this.earliestTranscriptMs = step.createdAtMs;
          metaChanged = true;
        }
        if (this.latestTranscriptMs === undefined || step.createdAtMs > this.latestTranscriptMs) {
          this.latestTranscriptMs = step.createdAtMs;
          metaChanged = true;
        }
      }
      if (step.toolName.length > 0) {
        this.terminalAssistantTurnObserved = false;
        this.hasInProgressGeneralStep = !step.isComplete;
      } else if (step.isTerminalAssistantResponse === true) {
        this.terminalAssistantTurnObserved = true;
        this.hasInProgressGeneralStep = false;
        metaChanged = true;
      } else {
        this.terminalAssistantTurnObserved = false;
      }
      if (metaChanged) {
        this.onTranscriptMeta?.({
          modelName: this.observedModelName,
          earliestCreatedAtMs: this.earliestTranscriptMs,
          latestCreatedAtMs: this.latestTranscriptMs,
          isTerminalAssistantTurn: this.terminalAssistantTurnObserved,
        });
      }
      if (step.toolName.length === 0) {
        continue;
      }
      const existing = this.emittedGeneralParts.get(step.stepKey);
      if (existing !== undefined) {
        if (
          existing.isComplete !== step.isComplete ||
          existing.isError !== step.isError ||
          existing.invocationMessage !== step.summary
        ) {
          existing.isComplete = step.isComplete;
          existing.isError = step.isError;
          existing.invocationMessage = step.summary;
          existing.pastTenseMessage = step.summary;
          this.onStepCallback?.(existing);
        }
        continue;
      }
      const part = new vscode.ChatToolInvocationPart(step.toolName, `${this.parentToolCallId}:${step.stepKey}`);
      part.invocationMessage = step.summary;
      part.pastTenseMessage = step.summary;
      part.isComplete = step.isComplete;
      part.isError = step.isError;
      part.subAgentInvocationId = this.parentToolCallId;
      part.subAgentName = this.subAgentName;
      this.emittedGeneralParts.set(step.stepKey, part);
      this.onStepCallback?.(part);
    }
  }

  private scanMediaFilesInDir(dirPath: string): void {
    const mediaFiles = listBrowserMediaFiles(dirPath);
    for (const mediaPath of mediaFiles) {
      const ext = path.extname(mediaPath).toLowerCase();
      if (VIDEO_EXTS.has(ext)) {
        this.discoveredWebmPaths.add(mediaPath);
        continue;
      }

      const normalizedPath = normalizeFsPath(mediaPath);
      if (this.emittedImagePaths.has(normalizedPath)) {
        continue;
      }

      const attachment = readMediaAttachment(mediaPath);
      if (attachment === undefined) {
        continue;
      }

      this.emittedImagePaths.add(normalizedPath);
      this.stepSequence += 1;
      const part = buildChildBrowserToolPart(
        'browser_screenshot',
        `${this.parentToolCallId}:media:${this.stepSequence}`,
        `Screenshot: ${path.basename(mediaPath)}`,
        true,
        [attachment],
      );
      part.subAgentInvocationId = this.parentToolCallId;
      part.subAgentName = 'Browser';
      this.onStepCallback?.(part);
    }
  }

  private emitParsedStep(step: ParsedTranscriptStep): void {
    for (const webmPath of step.webmPaths) {
      this.discoveredWebmPaths.add(webmPath);
    }

    if (step.needsInputReason !== undefined && !this.reportedNeedsInputReasons.has(step.needsInputReason)) {
      this.reportedNeedsInputReasons.add(step.needsInputReason);
      this.onNeedsInputCallback?.(step.needsInputReason);
    }

    if (this.emittedStepKeys.has(step.stepKey)) {
      return;
    }
    this.emittedStepKeys.add(step.stepKey);

    for (const image of step.images) {
      this.emittedImagePaths.add(normalizeFsPath(image.filePath));
    }

    const part = buildChildBrowserToolPart(
      step.toolName,
      `${this.parentToolCallId}:${step.stepKey}`,
      step.summary,
      step.isComplete,
      step.images,
    );
    part.subAgentInvocationId = this.parentToolCallId;
    part.subAgentName = 'Browser';
    this.onStepCallback?.(part);
  }
}

export class BrowserSubagentRenderer {
  private readonly brainRootDir: string;
  private readonly knownBrowserToolCallIds = new Set<string>();
  private readonly knownGeneralToolCallIds = new Set<string>();
  private readonly liveCalls = new Map<string, LiveBrowserCallState>();
  private onSubagentDiscovered: ((subagentId: string) => void) | undefined;

  public constructor(brainRootDir?: string, onSubagentDiscovered?: (subagentId: string) => void) {
    this.brainRootDir = brainRootDir ?? path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    this.onSubagentDiscovered = onSubagentDiscovered;
  }

  public setOnSubagentDiscovered(listener: ((subagentId: string) => void) | undefined): void {
    this.onSubagentDiscovered = listener;
  }

  public isBrowserSubagentCall(update: AcpToolCallUpdatePayload): boolean {
    if (update.name === 'invoke_subagent') {
      const argsTypeName = getStringProp(update.args, 'TypeName');
      const rawInputTypeName = getStringProp(update.rawInput, 'TypeName');
      if (argsTypeName === 'browser' || rawInputTypeName === 'browser') {
        this.knownBrowserToolCallIds.add(update.toolCallId);
        return true;
      }
      return false;
    }

    if (update.name === undefined && this.knownBrowserToolCallIds.has(update.toolCallId)) {
      return true;
    }

    return false;
  }

  public isSubagentCall(update: AcpToolCallUpdatePayload): boolean {
    if (this.isBrowserSubagentCall(update)) {
      return true;
    }
    if (isSubagentInvokeCall(update)) {
      this.knownGeneralToolCallIds.add(update.toolCallId);
      return true;
    }
    return update.name === undefined && this.knownGeneralToolCallIds.has(update.toolCallId);
  }

  public renderReplayToolCall(update: AcpToolCallUpdatePayload, sessionId: string): vscode.ChatResponsePart[] {
    if (!this.isBrowserSubagentCall(update) && isSubagentInvokeCall(update)) {
      return this.renderGeneralReplayToolCall(update, sessionId);
    }
    if (!this.isBrowserSubagentCall(update) && this.knownGeneralToolCallIds.has(update.toolCallId)) {
      return this.renderGeneralReplayToolCall(update, sessionId);
    }

    const inputObj = update.args ?? update.rawInput ?? {};
    const role =
      getStringProp(inputObj, 'Role') ?? getStringProp(inputObj, 'role') ?? update.title ?? 'Browser Automation';
    const prompt = getStringProp(inputObj, 'Prompt') ?? getStringProp(inputObj, 'prompt') ?? '';
    const resultText = extractToolResultText(update);
    const meta = extractSubagentCallMetadata(update);
    if (meta.conversationId !== undefined) {
      this.onSubagentDiscovered?.(meta.conversationId);
    }

    const parentPart = new vscode.ChatToolInvocationPart('browser', update.toolCallId);
    parentPart.invocationMessage = role;
    parentPart.pastTenseMessage = role;
    parentPart.isComplete = update.status !== 'pending' && update.status !== 'in_progress';
    parentPart.isError = update.status === 'failed';
    parentPart.toolSpecificData = new vscode.ChatSubagentToolInvocationData(role, 'Browser', prompt, resultText);

    const parts: vscode.ChatResponsePart[] = [parentPart as unknown as vscode.ChatResponsePart];

    const replayAssets = this.collectReplayAssets(update, sessionId, prompt, resultText);
    for (const childPart of replayAssets.childParts) {
      childPart.subAgentInvocationId = update.toolCallId;
      childPart.subAgentName = 'Browser';
      parts.push(childPart as unknown as vscode.ChatResponsePart);
    }

    for (const webmPath of replayAssets.webmPaths) {
      parts.push(createWebmPreviewButton(webmPath, role));
    }

    return parts;
  }

  public handleLiveToolCall(
    update: AcpToolCallUpdatePayload,
    sessionId: string,
    stream: Pick<vscode.ChatResponseStream, 'push'>,
    onNeedsInput?: (reason: string) => void,
  ): void {
    const existingState = this.liveCalls.get(update.toolCallId);
    const isBrowser = existingState !== undefined ? existingState.isBrowser : this.isBrowserSubagentCall(update);
    if (!isBrowser) {
      this.handleGeneralLiveToolCall(update, sessionId, stream);
      return;
    }

    let state = existingState;
    if (state === undefined) {
      const inputObj = update.args ?? update.rawInput ?? {};
      const role =
        getStringProp(inputObj, 'Role') ?? getStringProp(inputObj, 'role') ?? update.title ?? 'Browser Automation';
      const prompt = getStringProp(inputObj, 'Prompt') ?? getStringProp(inputObj, 'prompt') ?? '';

      const parentPart = new vscode.ChatToolInvocationPart('browser', update.toolCallId);
      parentPart.invocationMessage = role;
      parentPart.pastTenseMessage = role;
      parentPart.enablePartialUpdate = true;
      parentPart.isComplete = false;
      parentPart.toolSpecificData = new vscode.ChatSubagentToolInvocationData(role, 'Browser', prompt);

      stream.push(parentPart as unknown as vscode.ChatResponsePart);

      state = {
        sessionId,
        toolCallId: update.toolCallId,
        isBrowser: true,
        role,
        typeName: 'Browser',
        prompt,
        startedAt: Date.now(),
        modelName: undefined,
        subagentId: undefined,
        parentPart,
        watcher: undefined,
        emittedWebmPaths: new Set<string>(),
      };
      this.liveCalls.set(update.toolCallId, state);
    }

    const status = update.status ?? 'in_progress';

    if (status === 'pending' || status === 'in_progress') {
      if (state.watcher === undefined) {
        const watcher = new BrowserTrajectoryWatcher(this.brainRootDir);
        state.watcher = watcher;
        watcher.startWatching(
          update.toolCallId,
          state.prompt,
          (childPart) => {
            stream.push(childPart as unknown as vscode.ChatResponsePart);
          },
          onNeedsInput,
          sessionId,
        );
      }

      if (
        update.title !== undefined &&
        update.title.length > 0 &&
        state.parentPart.invocationMessage !== update.title
      ) {
        state.parentPart.invocationMessage = update.title;
        stream.push(state.parentPart as unknown as vscode.ChatResponsePart);
      }
      return;
    }

    const resultText = extractToolResultText(update);
    const discoveredWebms = new Set<string>();

    if (state.watcher !== undefined) {
      state.watcher.flush();
      for (const webmPath of state.watcher.getDiscoveredWebmPaths()) {
        discoveredWebms.add(webmPath);
      }
      state.watcher.stop();
      state.watcher = undefined;
    } else {
      const replayAssets = this.collectReplayAssets(update, sessionId, state.prompt, resultText);
      for (const childPart of replayAssets.childParts) {
        childPart.subAgentInvocationId = update.toolCallId;
        childPart.subAgentName = 'Browser';
        stream.push(childPart as unknown as vscode.ChatResponsePart);
      }
      for (const webmPath of replayAssets.webmPaths) {
        discoveredWebms.add(webmPath);
      }
    }

    for (const refPath of extractMediaPathsFromUpdate(update, resultText, this.brainRootDir, sessionId)) {
      if (VIDEO_EXTS.has(path.extname(refPath).toLowerCase())) {
        discoveredWebms.add(refPath);
      }
    }

    if (resultText !== undefined) {
      const needsInputReason = detectNeedsInputReason(resultText);
      if (needsInputReason !== undefined) {
        onNeedsInput?.(needsInputReason);
      }
    }

    state.parentPart.toolSpecificData = new vscode.ChatSubagentToolInvocationData(
      state.role,
      'Browser',
      state.prompt,
      resultText,
    );
    state.parentPart.isComplete = true;
    state.parentPart.isError = status === 'failed';
    stream.push(state.parentPart as unknown as vscode.ChatResponsePart);

    for (const webmPath of discoveredWebms) {
      const normalized = normalizeFsPath(webmPath);
      if (!state.emittedWebmPaths.has(normalized)) {
        state.emittedWebmPaths.add(normalized);
        stream.push(createWebmPreviewButton(webmPath, state.role));
      }
    }
  }

  private renderGeneralReplayToolCall(update: AcpToolCallUpdatePayload, sessionId: string): vscode.ChatResponsePart[] {
    const meta = extractSubagentCallMetadata(update);
    const resultText = extractToolResultText(update);
    const isComplete = update.status !== 'pending' && update.status !== 'in_progress';
    const isError = update.status === 'failed';
    const replayData = this.collectGeneralReplayData(update, sessionId, meta, resultText);
    const subagentId = replayData.subagentId ?? meta.conversationId;
    if (subagentId !== undefined) {
      this.onSubagentDiscovered?.(subagentId);
    }

    const parentPart = new vscode.ChatToolInvocationPart('invoke_subagent', update.toolCallId);
    parentPart.invocationMessage = meta.role;
    parentPart.pastTenseMessage = meta.role;
    parentPart.isComplete = isComplete;
    parentPart.isError = isError;
    if (isComplete && !isError) {
      parentPart.isConfirmed = true;
    }
    parentPart.toolSpecificData = buildGeneralSubagentToolData({
      typeName: meta.typeName,
      role: meta.role,
      prompt: meta.prompt,
      resultText,
      modelName: replayData.modelName ?? meta.modelName,
      startedAt: replayData.earliestMs,
      duration:
        replayData.earliestMs !== undefined && replayData.latestMs !== undefined
          ? Math.max(0, replayData.latestMs - replayData.earliestMs)
          : undefined,
      isActive: !isComplete,
      isError,
      subagentId,
    });

    const parts: vscode.ChatResponsePart[] = [parentPart as unknown as vscode.ChatResponsePart];
    for (const childPart of replayData.childParts) {
      childPart.subAgentInvocationId = update.toolCallId;
      childPart.subAgentName = meta.typeName;
      parts.push(childPart as unknown as vscode.ChatResponsePart);
    }
    return parts;
  }

  private handleGeneralLiveToolCall(
    update: AcpToolCallUpdatePayload,
    sessionId: string,
    stream: Pick<vscode.ChatResponseStream, 'push'>,
  ): void {
    const meta = extractSubagentCallMetadata(update);
    let state = this.liveCalls.get(update.toolCallId);

    if (state === undefined) {
      const startedAt = Date.now();
      const parentPart = new vscode.ChatToolInvocationPart('invoke_subagent', update.toolCallId);
      parentPart.invocationMessage = meta.role;
      parentPart.pastTenseMessage = meta.role;
      parentPart.enablePartialUpdate = true;
      parentPart.isComplete = false;
      if (meta.conversationId !== undefined) {
        this.onSubagentDiscovered?.(meta.conversationId);
      }
      parentPart.toolSpecificData = buildGeneralSubagentToolData({
        typeName: meta.typeName,
        role: meta.role,
        prompt: meta.prompt,
        resultText: undefined,
        modelName: meta.modelName,
        startedAt,
        duration: undefined,
        isActive: true,
        isError: false,
        subagentId: meta.conversationId,
      });

      stream.push(parentPart as unknown as vscode.ChatResponsePart);

      state = {
        sessionId,
        toolCallId: update.toolCallId,
        isBrowser: false,
        role: meta.role,
        typeName: meta.typeName,
        prompt: meta.prompt,
        startedAt,
        modelName: meta.modelName,
        subagentId: meta.conversationId,
        parentPart,
        watcher: undefined,
        emittedWebmPaths: new Set<string>(),
      };
      this.liveCalls.set(update.toolCallId, state);
    } else {
      if (meta.role.length > 0 && meta.role !== 'Subagent') {
        state.role = meta.role;
        state.parentPart.invocationMessage = meta.role;
        state.parentPart.pastTenseMessage = meta.role;
      }
      if (meta.modelName !== undefined && state.modelName === undefined) {
        state.modelName = meta.modelName;
      }
      if (meta.conversationId !== undefined && state.subagentId === undefined) {
        state.subagentId = meta.conversationId;
        this.onSubagentDiscovered?.(meta.conversationId);
        state.watcher?.setSubagentIdHint(meta.conversationId);
      }
    }

    const activeState = state;
    activeState.stream = stream;
    const status = update.status ?? 'in_progress';

    const ensureGeneralWatcher = (): void => {
      if (activeState.watcher !== undefined) {
        if (activeState.subagentId !== undefined) {
          activeState.watcher.setSubagentIdHint(activeState.subagentId);
        }
        return;
      }
      const watcher = new BrowserTrajectoryWatcher(this.brainRootDir, {
        browserOnly: false,
        subAgentName: activeState.typeName,
        subagentIdHint: activeState.subagentId,
        onDiscoveredSubagentId: (discoveredId): void => {
          if (activeState.subagentId === discoveredId) {
            return;
          }
          activeState.subagentId = discoveredId;
          this.onSubagentDiscovered?.(discoveredId);
          activeState.parentPart.toolSpecificData = buildGeneralSubagentToolData({
            typeName: activeState.typeName,
            role: activeState.role,
            prompt: activeState.prompt,
            resultText: undefined,
            modelName: activeState.modelName,
            startedAt: activeState.startedAt,
            duration: undefined,
            isActive: true,
            isError: false,
            subagentId: discoveredId,
          });
          activeState.stream?.push(activeState.parentPart as unknown as vscode.ChatResponsePart);
        },
        onTranscriptMeta: (transcriptMeta): void => {
          let changed = false;
          if (transcriptMeta.modelName !== undefined && activeState.modelName === undefined) {
            activeState.modelName = transcriptMeta.modelName;
            changed = true;
          }
          if (
            transcriptMeta.earliestCreatedAtMs !== undefined &&
            transcriptMeta.earliestCreatedAtMs < activeState.startedAt
          ) {
            activeState.startedAt = transcriptMeta.earliestCreatedAtMs;
            changed = true;
          }
          if (
            transcriptMeta.latestCreatedAtMs !== undefined &&
            (activeState.latestTranscriptMs === undefined ||
              transcriptMeta.latestCreatedAtMs > activeState.latestTranscriptMs)
          ) {
            activeState.latestTranscriptMs = transcriptMeta.latestCreatedAtMs;
          }
          if (transcriptMeta.isTerminalAssistantTurn === true && activeState.deferredInvokeComplete === true) {
            this.finalizeGeneralLiveCall(activeState, activeState.deferredResultText, false);
            return;
          }
          if (changed && activeState.parentPart.isComplete !== true) {
            activeState.parentPart.toolSpecificData = buildGeneralSubagentToolData({
              typeName: activeState.typeName,
              role: activeState.role,
              prompt: activeState.prompt,
              resultText: undefined,
              modelName: activeState.modelName,
              startedAt: activeState.startedAt,
              duration: undefined,
              isActive: true,
              isError: false,
              subagentId: activeState.subagentId,
            });
            activeState.stream?.push(activeState.parentPart as unknown as vscode.ChatResponsePart);
          }
        },
      });
      activeState.watcher = watcher;
      watcher.startWatching(
        update.toolCallId,
        activeState.prompt,
        (childPart) => {
          activeState.stream?.push(childPart as unknown as vscode.ChatResponsePart);
        },
        undefined,
        sessionId,
      );
    };

    if (status === 'pending' || status === 'in_progress') {
      ensureGeneralWatcher();

      if (
        update.title !== undefined &&
        update.title.length > 0 &&
        activeState.parentPart.invocationMessage !== update.title
      ) {
        activeState.role = update.title;
        activeState.parentPart.invocationMessage = update.title;
        activeState.parentPart.pastTenseMessage = update.title;
      }

      activeState.parentPart.toolSpecificData = buildGeneralSubagentToolData({
        typeName: activeState.typeName,
        role: activeState.role,
        prompt: activeState.prompt,
        resultText: undefined,
        modelName: activeState.modelName,
        startedAt: activeState.startedAt,
        duration: undefined,
        isActive: true,
        isError: false,
        subagentId: activeState.subagentId,
      });
      stream.push(activeState.parentPart as unknown as vscode.ChatResponsePart);
      return;
    }

    const resultText = extractToolResultText(update);
    const isError = status === 'failed';
    activeState.deferredResultText = resultText;

    if (activeState.subagentId === undefined) {
      const fromText = extractSubagentCallMetadata({ ...update, rawOutput: update.rawOutput }).conversationId;
      if (fromText !== undefined) {
        activeState.subagentId = fromText;
      } else if (resultText !== undefined) {
        const match = /conversation:\/\/([a-zA-Z0-9_-]+)/.exec(resultText);
        if (match?.[1] !== undefined) {
          activeState.subagentId = match[1];
        }
      }
    }

    if (activeState.subagentId !== undefined) {
      this.onSubagentDiscovered?.(activeState.subagentId);
      if (!isError) {
        ensureGeneralWatcher();
      }
    }

    if (activeState.watcher !== undefined) {
      activeState.watcher.flush();
      const matchedId = activeState.watcher.getMatchedSubagentId();
      if (matchedId !== undefined && activeState.subagentId === undefined) {
        activeState.subagentId = matchedId;
        this.onSubagentDiscovered?.(matchedId);
      }
    }

    const shouldKeepWatching =
      !isError &&
      activeState.subagentId !== undefined &&
      activeState.watcher !== undefined &&
      !activeState.watcher.hasCompletedAssistantTurn() &&
      (activeState.watcher.hasPendingSteps() ||
        isAsyncSubagentLaunchResult(resultText, update.rawOutput) ||
        (resultText === undefined && activeState.watcher.hasTranscriptFile()));

    if (shouldKeepWatching) {
      activeState.deferredInvokeComplete = true;
      activeState.parentPart.isComplete = false;
      activeState.parentPart.isError = false;
      activeState.parentPart.toolSpecificData = buildGeneralSubagentToolData({
        typeName: activeState.typeName,
        role: activeState.role,
        prompt: activeState.prompt,
        resultText: undefined,
        modelName: activeState.modelName,
        startedAt: activeState.startedAt,
        duration: undefined,
        isActive: true,
        isError: false,
        subagentId: activeState.subagentId,
      });
      stream.push(activeState.parentPart as unknown as vscode.ChatResponsePart);
      return;
    }

    this.finalizeGeneralLiveCall(activeState, resultText, isError);
  }

  private finalizeGeneralLiveCall(
    activeState: LiveBrowserCallState,
    resultText: string | undefined,
    isError: boolean,
  ): void {
    const stream = activeState.stream;
    let transcriptDuration: number | undefined;

    if (activeState.watcher !== undefined) {
      activeState.watcher.flush();
      const matchedId = activeState.watcher.getMatchedSubagentId();
      if (matchedId !== undefined && activeState.subagentId === undefined) {
        activeState.subagentId = matchedId;
        this.onSubagentDiscovered?.(matchedId);
      }
      transcriptDuration = activeState.watcher.getTranscriptElapsedMs();
      activeState.watcher.stop();
      activeState.watcher = undefined;
    } else if (stream !== undefined) {
      const replayData = this.collectGeneralReplayData(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: activeState.toolCallId,
          rawInput: { TypeName: activeState.typeName, Role: activeState.role, Prompt: activeState.prompt },
          rawOutput: resultText !== undefined ? { text: resultText } : undefined,
        },
        activeState.sessionId,
        {
          typeName: activeState.typeName,
          role: activeState.role,
          prompt: activeState.prompt,
          modelName: activeState.modelName,
          conversationId: activeState.subagentId,
          isBrowser: false,
        },
        resultText,
      );
      if (replayData.subagentId !== undefined && activeState.subagentId === undefined) {
        activeState.subagentId = replayData.subagentId;
        this.onSubagentDiscovered?.(replayData.subagentId);
      }
      if (replayData.modelName !== undefined && activeState.modelName === undefined) {
        activeState.modelName = replayData.modelName;
      }
      if (
        replayData.earliestMs !== undefined &&
        replayData.latestMs !== undefined &&
        replayData.latestMs >= replayData.earliestMs
      ) {
        transcriptDuration = replayData.latestMs - replayData.earliestMs;
      }
      for (const childPart of replayData.childParts) {
        childPart.subAgentInvocationId = activeState.toolCallId;
        childPart.subAgentName = activeState.typeName;
        stream.push(childPart as unknown as vscode.ChatResponsePart);
      }
    }

    if (
      transcriptDuration === undefined &&
      activeState.latestTranscriptMs !== undefined &&
      activeState.latestTranscriptMs >= activeState.startedAt
    ) {
      transcriptDuration = activeState.latestTranscriptMs - activeState.startedAt;
    }

    const duration = transcriptDuration ?? Math.max(0, Date.now() - activeState.startedAt);
    activeState.parentPart.isComplete = true;
    activeState.parentPart.isError = isError;
    if (!isError) {
      activeState.parentPart.isConfirmed = true;
    }
    activeState.parentPart.toolSpecificData = buildGeneralSubagentToolData({
      typeName: activeState.typeName,
      role: activeState.role,
      prompt: activeState.prompt,
      resultText,
      modelName: activeState.modelName,
      startedAt: activeState.startedAt,
      duration,
      isActive: false,
      isError,
      subagentId: activeState.subagentId,
    });
    stream?.push(activeState.parentPart as unknown as vscode.ChatResponsePart);
  }

  private collectGeneralReplayData(
    update: AcpToolCallUpdatePayload,
    sessionId: string,
    meta: SubagentCallMetadata,
    resultText: string | undefined,
  ): {
    readonly subagentId: string | undefined;
    readonly childParts: vscode.ChatToolInvocationPart[];
    readonly modelName: string | undefined;
    readonly earliestMs: number | undefined;
    readonly latestMs: number | undefined;
  } {
    const candidateDirs = this.findGeneralReplayCandidateDirs(sessionId, meta, resultText);
    const childParts: vscode.ChatToolInvocationPart[] = [];
    const seenKeys = new Set<string>();
    let seq = 0;
    let modelName = meta.modelName;
    let earliestMs: number | undefined;
    let latestMs: number | undefined;
    let resolvedSubagentId = meta.conversationId;

    for (const dirPath of candidateDirs) {
      const transcriptPath = getTranscriptPath(dirPath);
      if (!fs.existsSync(transcriptPath)) {
        continue;
      }
      if (resolvedSubagentId === undefined) {
        const candidateId = path.basename(dirPath);
        if (candidateId !== sessionId) {
          resolvedSubagentId = candidateId;
        }
      }
      const lines = safeReadUtf8Lines(transcriptPath);
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(parsed)) {
          continue;
        }
        const steps = parseGeneralTranscriptRecord(parsed, () => {
          seq += 1;
          return seq;
        });
        for (const step of steps) {
          if (step.modelName !== undefined) {
            modelName = step.modelName;
          }
          if (step.createdAtMs !== undefined) {
            earliestMs = earliestMs === undefined ? step.createdAtMs : Math.min(earliestMs, step.createdAtMs);
            latestMs = latestMs === undefined ? step.createdAtMs : Math.max(latestMs, step.createdAtMs);
          }
          if (step.toolName.length === 0 || seenKeys.has(step.stepKey)) {
            continue;
          }
          seenKeys.add(step.stepKey);
          const childPart = new vscode.ChatToolInvocationPart(step.toolName, `${update.toolCallId}:${step.stepKey}`);
          childPart.invocationMessage = step.summary;
          childPart.pastTenseMessage = step.summary;
          childPart.isComplete = step.isComplete;
          childPart.isError = step.isError;
          childParts.push(childPart);
        }
      }
    }

    return {
      subagentId: resolvedSubagentId,
      childParts,
      modelName,
      earliestMs,
      latestMs,
    };
  }

  private findGeneralReplayCandidateDirs(
    sessionId: string,
    meta: SubagentCallMetadata,
    resultText: string | undefined,
  ): string[] {
    const dirs: string[] = [];
    const seen = new Set<string>();
    const addIfExists = (dirPath: string): void => {
      const normalized = normalizeFsPath(dirPath);
      if (!seen.has(normalized) && fs.existsSync(dirPath)) {
        seen.add(normalized);
        dirs.push(dirPath);
      }
    };

    if (meta.conversationId !== undefined && meta.conversationId.length > 0) {
      addIfExists(path.join(this.brainRootDir, meta.conversationId));
    }
    if (resultText !== undefined) {
      for (const match of resultText.matchAll(/conversation:\/\/([a-zA-Z0-9_-]+)/g)) {
        if (match[1] !== undefined && match[1].length > 0) {
          addIfExists(path.join(this.brainRootDir, match[1]));
        }
      }
    }
    const normalizedPrompt = normalizePromptSnippet(meta.prompt);
    if (normalizedPrompt.length > 0 && fs.existsSync(this.brainRootDir)) {
      try {
        for (const entry of fs.readdirSync(this.brainRootDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === sessionId) {
            continue;
          }
          const dirPath = path.join(this.brainRootDir, entry.name);
          const transcriptPath = getTranscriptPath(dirPath);
          if (fs.existsSync(transcriptPath) && transcriptMatchesPrompt(transcriptPath, normalizedPrompt)) {
            addIfExists(dirPath);
          }
        }
      } catch {
        // Ignore directory read errors.
      }
    }
    return dirs;
  }

  public disposeSession(sessionId: string): void {
    for (const [toolCallId, state] of this.liveCalls.entries()) {
      if (state.sessionId === sessionId) {
        if (!state.isBrowser && state.parentPart.isComplete !== true) {
          this.finalizeGeneralLiveCall(state, state.deferredResultText, state.parentPart.isError === true);
        } else {
          state.watcher?.stop();
          state.watcher = undefined;
        }
        this.liveCalls.delete(toolCallId);
      }
    }
  }

  private collectReplayAssets(
    update: AcpToolCallUpdatePayload,
    sessionId: string,
    prompt: string,
    resultText: string | undefined,
  ): { readonly childParts: vscode.ChatToolInvocationPart[]; readonly webmPaths: string[] } {
    const candidateDirs = this.findReplayCandidateDirs(sessionId, prompt, update, resultText);
    const childParts: vscode.ChatToolInvocationPart[] = [];
    const seenStepKeys = new Set<string>();
    const seenImagePaths = new Set<string>();
    const seenWebmPaths = new Map<string, string>();
    let stepSequence = 0;

    for (const dirPath of candidateDirs) {
      const transcriptPath = getTranscriptPath(dirPath);
      if (fs.existsSync(transcriptPath)) {
        const lines = safeReadUtf8Lines(transcriptPath);
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const parsedSteps = parseTranscriptJsonLine(trimmed, dirPath, () => {
            stepSequence += 1;
            return stepSequence;
          });
          for (const step of parsedSteps) {
            for (const webmPath of step.webmPaths) {
              seenWebmPaths.set(normalizeFsPath(webmPath), webmPath);
            }
            if (seenStepKeys.has(step.stepKey)) {
              continue;
            }
            seenStepKeys.add(step.stepKey);
            for (const img of step.images) {
              seenImagePaths.add(normalizeFsPath(img.filePath));
            }
            childParts.push(
              buildChildBrowserToolPart(
                step.toolName,
                `${update.toolCallId}:${step.stepKey}`,
                step.summary,
                step.isComplete,
                step.images,
              ),
            );
          }
        }
      }

      for (const mediaPath of listBrowserMediaFiles(dirPath)) {
        const ext = path.extname(mediaPath).toLowerCase();
        const normalized = normalizeFsPath(mediaPath);
        if (VIDEO_EXTS.has(ext)) {
          seenWebmPaths.set(normalized, mediaPath);
          continue;
        }
        if (seenImagePaths.has(normalized)) {
          continue;
        }
        const attachment = readMediaAttachment(mediaPath);
        if (attachment === undefined) {
          continue;
        }
        seenImagePaths.add(normalized);
        stepSequence += 1;
        childParts.push(
          buildChildBrowserToolPart(
            'browser_screenshot',
            `${update.toolCallId}:media:${stepSequence}`,
            `Screenshot: ${path.basename(mediaPath)}`,
            true,
            [attachment],
          ),
        );
      }
    }

    for (const explicitMediaPath of extractMediaPathsFromUpdate(update, resultText, this.brainRootDir, sessionId)) {
      const ext = path.extname(explicitMediaPath).toLowerCase();
      const normalized = normalizeFsPath(explicitMediaPath);
      if (VIDEO_EXTS.has(ext)) {
        seenWebmPaths.set(normalized, explicitMediaPath);
        continue;
      }
      if (!seenImagePaths.has(normalized) && IMAGE_MIME_BY_EXT[ext] !== undefined) {
        const attachment = readMediaAttachment(explicitMediaPath);
        if (attachment !== undefined) {
          seenImagePaths.add(normalized);
          stepSequence += 1;
          childParts.push(
            buildChildBrowserToolPart(
              'browser_screenshot',
              `${update.toolCallId}:media:${stepSequence}`,
              `Screenshot: ${path.basename(explicitMediaPath)}`,
              true,
              [attachment],
            ),
          );
        }
      }
    }

    return {
      childParts,
      webmPaths: Array.from(seenWebmPaths.values()),
    };
  }

  private findReplayCandidateDirs(
    sessionId: string,
    prompt: string,
    update: AcpToolCallUpdatePayload,
    resultText: string | undefined,
  ): string[] {
    const dirs: string[] = [];
    const seen = new Set<string>();

    const addDirIfExists = (candidatePath: string): void => {
      const normalized = normalizeFsPath(candidatePath);
      if (!seen.has(normalized) && fs.existsSync(candidatePath)) {
        seen.add(normalized);
        dirs.push(candidatePath);
      }
    };

    if (sessionId.length > 0) {
      addDirIfExists(path.join(this.brainRootDir, sessionId));
    }

    if (resultText !== undefined) {
      const conversationRegex = /conversation:\/\/([a-zA-Z0-9_-]+)/g;
      for (const match of resultText.matchAll(conversationRegex)) {
        const convId = match[1];
        if (convId !== undefined && convId.length > 0) {
          addDirIfExists(path.join(this.brainRootDir, convId));
        }
      }
    }

    for (const mediaPath of extractMediaPathsFromUpdate(update, resultText, this.brainRootDir, sessionId)) {
      addDirIfExists(path.dirname(mediaPath));
    }

    const normalizedPrompt = normalizePromptSnippet(prompt);
    if (normalizedPrompt.length > 0 && fs.existsSync(this.brainRootDir)) {
      try {
        const entries = fs.readdirSync(this.brainRootDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }
          const candidateDir = path.join(this.brainRootDir, entry.name);
          const transcriptPath = getTranscriptPath(candidateDir);
          if (fs.existsSync(transcriptPath) && transcriptMatchesPrompt(transcriptPath, normalizedPrompt)) {
            addDirIfExists(candidateDir);
          }
        }
      } catch {
        // Ignore directory read errors.
      }
    }

    return dirs;
  }
}

function buildGeneralSubagentToolData(params: {
  readonly typeName: string;
  readonly role: string;
  readonly prompt: string;
  readonly resultText: string | undefined;
  readonly modelName: string | undefined;
  readonly startedAt: number | undefined;
  readonly duration: number | undefined;
  readonly isActive: boolean;
  readonly isError: boolean;
  readonly subagentId: string | undefined;
}): Record<string, unknown> {
  const displayName = params.typeName.length > 0 ? params.typeName : 'Subagent';
  return {
    kind: 'subagent',
    description: params.role,
    agentName: displayName,
    agentDisplayName: displayName,
    prompt: params.prompt,
    ...(params.resultText !== undefined ? { result: params.resultText } : {}),
    ...(params.modelName !== undefined ? { modelId: params.modelName, modelName: params.modelName } : {}),
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    ...(params.duration !== undefined ? { duration: params.duration } : {}),
    isActive: params.isActive,
    isError: params.isError,
    ...(params.subagentId !== undefined
      ? { chatResource: buildSubagentChatResource(params.subagentId), isChatAvailable: true }
      : {}),
  };
}

function createWebmPreviewButton(webmPath: string, role: string): vscode.ChatResponseCommandButtonPart {
  return new vscode.ChatResponseCommandButtonPart({
    command: 'antigravityHarness.openMediaPreview',
    title: '$(device-camera-video) Play Browser Recording (.webm)',
    arguments: [webmPath, role],
  });
}

function buildChildBrowserToolPart(
  toolName: string,
  toolCallId: string,
  summary: string,
  isComplete: boolean,
  images: readonly ParsedMediaAttachment[],
): vscode.ChatToolInvocationPart {
  const part = new vscode.ChatToolInvocationPart(toolName, toolCallId);
  part.invocationMessage = summary;
  part.pastTenseMessage = summary;
  part.isComplete = isComplete;

  if (images.length > 0) {
    part.toolSpecificData = {
      input: summary,
      output: images.map((img) => ({
        mimeType: img.mimeType,
        data: img.data,
      })),
    };
  }

  return part;
}

function parseTranscriptJsonLine(
  jsonLine: string,
  baseDir: string,
  nextSequence: () => number,
): ParsedTranscriptStep[] {
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(jsonLine) as unknown;
  } catch {
    return [];
  }

  if (!isRecord(rawParsed)) {
    return [];
  }

  const stepIndex = getNumberProp(rawParsed, 'step_index');
  const statusStr = getStringProp(rawParsed, 'status');
  const isComplete =
    statusStr !== 'PENDING' && statusStr !== 'IN_PROGRESS' && statusStr !== 'pending' && statusStr !== 'in_progress';
  const lineContent =
    getStringProp(rawParsed, 'content') ??
    getStringProp(rawParsed, 'text') ??
    getStringProp(rawParsed, 'message') ??
    '';
  const thinking = getStringProp(rawParsed, 'thinking') ?? '';
  const combinedText = `${lineContent}\n${thinking}`.trim();
  const needsInputReason = detectNeedsInputReason(combinedText);

  const attachedMedia = extractMediaAttachmentsFromRecord(rawParsed, baseDir);
  const images = attachedMedia
    .filter((item) => item.attachment !== undefined)
    .map((item) => item.attachment as ParsedMediaAttachment);
  const webmPaths = attachedMedia.filter((item) => item.webmPath !== undefined).map((item) => item.webmPath as string);

  const rawToolCalls = getArrayProp(rawParsed, 'tool_calls') ?? getArrayProp(rawParsed, 'toolCalls');
  const steps: ParsedTranscriptStep[] = [];

  if (rawToolCalls !== undefined && rawToolCalls.length > 0) {
    let attachedToFirstTool = false;
    for (const rawTool of rawToolCalls) {
      if (!isRecord(rawTool)) {
        continue;
      }
      const toolName = getStringProp(rawTool, 'name') ?? getStringProp(rawTool, 'tool') ?? '';
      if (!isBrowserActionName(toolName)) {
        continue;
      }
      const argsObj = parseToolArguments(rawTool.arguments ?? rawTool.args ?? rawTool.rawInput ?? rawTool.input);
      const explicitId = getStringProp(rawTool, 'id') ?? getStringProp(rawTool, 'toolCallId');
      const seq = nextSequence();
      const stepKey = explicitId ?? `step-${stepIndex ?? seq}-${seq}`;
      const summary = formatBrowserActionSummary(toolName, argsObj, lineContent);

      steps.push({
        stepKey,
        toolName,
        summary,
        isComplete,
        images: attachedToFirstTool ? [] : images,
        webmPaths: attachedToFirstTool ? [] : webmPaths,
        needsInputReason: attachedToFirstTool ? undefined : needsInputReason,
      });
      attachedToFirstTool = true;
    }

    if (steps.length > 0) {
      return steps;
    }
  }

  const directActionName =
    getStringProp(rawParsed, 'tool') ?? getStringProp(rawParsed, 'name') ?? getStringProp(rawParsed, 'action') ?? '';
  if (isBrowserActionName(directActionName)) {
    const seq = nextSequence();
    const explicitId = getStringProp(rawParsed, 'id') ?? getStringProp(rawParsed, 'toolCallId');
    const stepKey = explicitId ?? `step-${stepIndex ?? seq}-${seq}`;
    const argsObj = parseToolArguments(rawParsed.arguments ?? rawParsed.args ?? rawParsed.input) ?? rawParsed;
    const summary =
      getStringProp(rawParsed, 'summary') ?? formatBrowserActionSummary(directActionName, argsObj, lineContent);
    return [
      {
        stepKey,
        toolName: directActionName,
        summary,
        isComplete,
        images,
        webmPaths,
        needsInputReason,
      },
    ];
  }

  if (images.length > 0 || webmPaths.length > 0) {
    const seq = nextSequence();
    const stepKey = `media-step-${stepIndex ?? seq}-${seq}`;
    const summary = lineContent.length > 0 ? truncateText(lineContent, 100) : 'Browser visual update';
    return [
      {
        stepKey,
        toolName: 'browser_screenshot',
        summary,
        isComplete,
        images,
        webmPaths,
        needsInputReason,
      },
    ];
  }

  if (needsInputReason !== undefined) {
    const seq = nextSequence();
    return [
      {
        stepKey: `needs-input-${stepIndex ?? seq}-${seq}`,
        toolName: 'browser_wait_for_user',
        summary: needsInputReason,
        isComplete: false,
        images: [],
        webmPaths: [],
        needsInputReason,
      },
    ];
  }

  return [];
}

function extractMediaAttachmentsFromRecord(
  record: Record<string, unknown>,
  baseDir: string,
): Array<{ readonly attachment?: ParsedMediaAttachment; readonly webmPath?: string }> {
  const results: Array<{ readonly attachment?: ParsedMediaAttachment; readonly webmPath?: string }> = [];
  const rawMedia = getArrayProp(record, 'media');
  const candidateUris: Array<{ readonly uri: string; readonly mimeType: string | undefined }> = [];

  if (rawMedia !== undefined) {
    for (const item of rawMedia) {
      if (!isRecord(item)) {
        continue;
      }
      const uri =
        getStringProp(item, 'uri') ??
        getStringProp(item, 'path') ??
        getStringProp(item, 'filePath') ??
        getStringProp(item, 'file');
      if (uri === undefined || uri.length === 0) {
        continue;
      }
      const mimeType = getStringProp(item, 'mime_type') ?? getStringProp(item, 'mimeType');
      candidateUris.push({ uri, mimeType });
    }
  }

  const screenshotField = getStringProp(record, 'screenshot') ?? getStringProp(record, 'imagePath');
  if (screenshotField !== undefined && screenshotField.length > 0) {
    candidateUris.push({ uri: screenshotField, mimeType: undefined });
  }

  for (const candidate of candidateUris) {
    const resolvedPath = resolveMediaUriToPath(candidate.uri, baseDir);
    if (resolvedPath === undefined || !fs.existsSync(resolvedPath)) {
      continue;
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    if (VIDEO_EXTS.has(ext)) {
      results.push({ webmPath: resolvedPath });
      continue;
    }
    const attachment = readMediaAttachment(resolvedPath, candidate.mimeType);
    if (attachment !== undefined) {
      results.push({ attachment });
    }
  }

  return results;
}

function readMediaAttachment(filePath: string, explicitMimeType?: string): ParsedMediaAttachment | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = explicitMimeType ?? IMAGE_MIME_BY_EXT[ext];
  if (mimeType === undefined || !mimeType.startsWith('image/')) {
    return undefined;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    return {
      filePath,
      mimeType,
      data: new Uint8Array(buffer),
    };
  } catch {
    return undefined;
  }
}

function extractMediaPathsFromUpdate(
  update: AcpToolCallUpdatePayload,
  resultText: string | undefined,
  brainRootDir: string,
  sessionId: string,
): string[] {
  const paths = new Set<string>();
  const baseDir = sessionId.length > 0 ? path.join(brainRootDir, sessionId) : brainRootDir;

  if (update.locations !== undefined) {
    for (const loc of update.locations) {
      if (loc.path.length > 0 && isMediaFileExtension(loc.path) && fs.existsSync(loc.path)) {
        paths.add(loc.path);
      }
    }
  }

  if (update.rawOutput !== undefined) {
    collectMediaStringsFromUnknown(update.rawOutput, baseDir, paths);
  }

  if (resultText !== undefined) {
    const pathMatches = resultText.match(/(?:[a-zA-Z]:[\\/][^\s"'<>]+|\/[^\s"'<>]+)\.(?:png|webp|jpe?g|webm)/gi);
    if (pathMatches !== null) {
      for (const candidate of pathMatches) {
        if (fs.existsSync(candidate)) {
          paths.add(candidate);
        }
      }
    }
  }

  return Array.from(paths);
}

function collectMediaStringsFromUnknown(value: unknown, baseDir: string, out: Set<string>): void {
  if (typeof value === 'string') {
    if (isMediaFileExtension(value)) {
      const resolved = resolveMediaUriToPath(value, baseDir);
      if (resolved !== undefined && fs.existsSync(resolved)) {
        out.add(resolved);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaStringsFromUnknown(item, baseDir, out);
    }
    return;
  }

  if (isRecord(value)) {
    for (const fieldValue of Object.values(value)) {
      collectMediaStringsFromUnknown(fieldValue, baseDir, out);
    }
  }
}

function listBrowserMediaFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const found: string[] = [];
  const directoriesToCheck = [
    dirPath,
    path.join(dirPath, '.system_generated', 'media'),
    path.join(dirPath, '.system_generated', 'screenshots'),
  ];

  for (const currentDir of directoriesToCheck) {
    if (!fs.existsSync(currentDir)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const sorted = entries
      .filter((entry) => entry.isFile() && isMediaFileExtension(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      found.push(path.join(currentDir, entry.name));
    }
  }

  return found;
}

function isMediaFileExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] !== undefined || VIDEO_EXTS.has(ext);
}

function resolveMediaUriToPath(uriOrPath: string, baseDir: string): string | undefined {
  if (uriOrPath.length === 0) {
    return undefined;
  }
  if (uriOrPath.startsWith('file://')) {
    try {
      return vscode.Uri.parse(uriOrPath).fsPath;
    } catch {
      return undefined;
    }
  }
  if (path.isAbsolute(uriOrPath)) {
    return uriOrPath;
  }
  return path.resolve(baseDir, uriOrPath);
}

function isBrowserActionName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  const lower = name.toLowerCase();
  return lower.startsWith('browser_') || BROWSER_ACTION_NAMES.has(lower);
}

function formatBrowserActionSummary(
  toolName: string,
  args: Record<string, unknown> | undefined,
  fallbackText: string,
): string {
  if (args !== undefined) {
    const url = getStringProp(args, 'url') ?? getStringProp(args, 'Url');
    if (url !== undefined && url.length > 0) {
      return `${toolName}: ${url}`;
    }
    const selector = getStringProp(args, 'selector') ?? getStringProp(args, 'target') ?? getStringProp(args, 'element');
    if (selector !== undefined && selector.length > 0) {
      return `${toolName}: ${selector}`;
    }
    const text = getStringProp(args, 'text') ?? getStringProp(args, 'value') ?? getStringProp(args, 'key');
    if (text !== undefined && text.length > 0) {
      return `${toolName}: "${truncateText(text, 60)}"`;
    }
  }

  if (fallbackText.length > 0) {
    return `${toolName}: ${truncateText(fallbackText, 80)}`;
  }
  return toolName;
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractToolResultText(update: AcpToolCallUpdatePayload): string | undefined {
  const chunks: string[] = [];

  if (update.rawOutput !== undefined) {
    const directText =
      getStringProp(update.rawOutput, 'text') ??
      getStringProp(update.rawOutput, 'result') ??
      getStringProp(update.rawOutput, 'output') ??
      getStringProp(update.rawOutput, 'message');
    if (directText !== undefined && directText.length > 0) {
      chunks.push(directText);
    }
  }

  if (update.content !== undefined) {
    for (const item of update.content) {
      const extracted = extractTextFromContentItem(item);
      if (extracted !== undefined && extracted.length > 0) {
        chunks.push(extracted);
      }
    }
  }

  if (chunks.length === 0) {
    return undefined;
  }
  return chunks.join('\n');
}

function extractTextFromContentItem(item: AcpToolCallContentItem): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  if (item.type === 'content' && isRecord(item.content)) {
    return getStringProp(item.content, 'text');
  }
  return getStringProp(item, 'text');
}

function detectNeedsInputReason(text: string): string | undefined {
  const match = NEEDS_INPUT_PATTERN.exec(text);
  if (match === null) {
    return undefined;
  }
  return `Browser subagent paused for user input (${match[0]}). Complete the check in Chrome and continue.`;
}

function getTranscriptPath(subagentDir: string): string {
  return path.join(subagentDir, '.system_generated', 'logs', 'transcript.jsonl');
}

function transcriptMatchesPrompt(transcriptPath: string, normalizedPromptSnippet: string): boolean {
  const lines = safeReadUtf8Lines(transcriptPath, 10);
  const combined = lines.join(' ').toLowerCase();
  return combined.includes(normalizedPromptSnippet);
}

function safeReadUtf8Lines(filePath: string, maxLines?: number): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    return maxLines !== undefined ? lines.slice(0, maxLines) : lines;
  } catch {
    return [];
  }
}

function safeStatMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function normalizePromptSnippet(prompt: string): string {
  const collapsed = prompt.trim().replace(/\s+/g, ' ').toLowerCase();
  return collapsed.slice(0, 64);
}

function normalizeFsPath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function isCompleteJsonLine(line: string): boolean {
  if (line.length === 0) {
    return false;
  }
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function truncateText(text: string, maxLen: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxLen - 3))}...`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getStringProp(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumberProp(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (record === undefined) {
    return undefined;
  }
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function isAsyncSubagentLaunchResult(
  resultText: string | undefined,
  rawOutput: Record<string, unknown> | undefined,
): boolean {
  if (rawOutput !== undefined) {
    const hasConversationRef =
      typeof rawOutput.conversationId === 'string' ||
      typeof rawOutput.conversation_id === 'string' ||
      typeof rawOutput.logAbsoluteUri === 'string';
    const hasExplicitSummaryText =
      typeof rawOutput.text === 'string' &&
      rawOutput.text.trim().length > 0 &&
      !/conversation:\/\/|\b(?:launched|started|spawned|background|running|async)\b/i.test(rawOutput.text);
    if (hasConversationRef && !hasExplicitSummaryText) {
      return true;
    }
  }
  if (resultText === undefined) {
    return false;
  }
  const trimmed = resultText.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/conversation:\/\/|\b(?:launched|started|spawned|running|background|async(?:hronous)?)\b/i.test(trimmed)) {
    return true;
  }
  return trimmed.startsWith('{') && /"conversationId"|"conversation_id"|"logAbsoluteUri"/.test(trimmed);
}

function getArrayProp(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  if (record === undefined) {
    return undefined;
  }
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}
