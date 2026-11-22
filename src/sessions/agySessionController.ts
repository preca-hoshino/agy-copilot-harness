import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpSessionSummary } from '../acp/acpTypes.js';
import type { AcpBackendInterface } from '../shared/contracts.js';
import { ANTIGRAVITY_SCHEME } from '../shared/contracts.js';

export interface ActiveTurnSnapshot {
  readonly userPrompt: string;
  readonly assistantPartialResponse: string;
}

export interface SideChatContextMetadata {
  readonly sourceSessionId: string;
  readonly turnId?: string | undefined;
  readonly selection?: string | undefined;
  readonly includeSourceContext: boolean;
  readonly inFlightSnapshot?: ActiveTurnSnapshot | undefined;
  readonly forkedFromBackend: boolean;
  contextInjected: boolean;
}

export interface EditingActionNotification {
  readonly uri?: unknown;
  readonly outcome?: string | undefined;
  readonly hasRemainingEdits?: boolean | undefined;
}

export interface AgyModePickerMeta {
  readonly provider: 'antigravity';
  readonly category: 'mode' | 'permission';
  readonly pickerLabel: string;
  readonly shortLabel: string;
  readonly detail: string;
  readonly tone: '' | 'info' | 'warning';
  readonly lastInteractiveMode: string;
}

interface AgyChatSessionProviderOptionItem extends vscode.ChatSessionProviderOptionItem {
  readonly agyPickerMeta: AgyModePickerMeta;
}

interface ModeOptionDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
}

const MODE_OPTIONS: readonly ModeOptionDescriptor[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Ask before edits and commands',
    icon: 'shield',
  },
  {
    id: 'accept-edits',
    name: 'Accept edits',
    description: 'Auto-approve workspace file edits',
    icon: 'edit',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Automatically approve one-time tool requests',
    icon: 'zap',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Plan changes before executing',
    icon: 'checklist',
  },
];

const WATCH_DEBOUNCE_MS = 1500;
const MIN_WATCHER_REFRESH_INTERVAL_MS = 3000;
const MAX_TITLE_LENGTH = 60;

function isTransientConversationFile(filename: string | Buffer | null | undefined): boolean {
  if (filename === null || filename === undefined) {
    return false;
  }
  const lower = filename.toString().toLowerCase();
  return (
    lower.endsWith('-wal') ||
    lower.endsWith('-shm') ||
    lower.endsWith('-journal') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.lock')
  );
}

function buildItemsSignature(items: readonly vscode.ChatSessionItem[]): string {
  return items
    .map((item) => {
      const desc = typeof item.description === 'string' ? item.description : '';
      const tip = typeof item.tooltip === 'string' ? item.tooltip : '';
      const created = item.timing?.created ?? '';
      const ended = item.timing?.lastRequestEnded ?? '';
      const changesCount = Array.isArray(item.changes) ? item.changes.length : 0;
      return `${item.resource.toString()}|${item.label}|${desc}|${tip}|${String(item.status ?? '')}|${String(created)}|${String(ended)}|${changesCount}`;
    })
    .join('\n');
}

export function normalizeAcpCwd(rawCwd: string): string {
  if (rawCwd.length === 0) {
    return '';
  }

  let candidate = rawCwd;
  if (rawCwd.toLowerCase().startsWith('file://')) {
    candidate = parseFileUriToPath(rawCwd);
  } else if (/^\/[a-z](?::|%3a)(?:\/|$)/i.test(rawCwd)) {
    // ACP can encode path segments without encoding the drive colon.
    candidate = decodePercentSequences(rawCwd);
  }

  // Handle Windows UNC paths such as //server/share/dir or \\server\share\dir
  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    const uncNormalized = path.win32.normalize(candidate.replace(/\//g, '\\'));
    return trimTrailingWinSeparator(uncNormalized);
  }

  // Handle ACP/URI-style Windows paths like /d:/Code Library/... or /C:
  const leadingSlashDriveMatch = /^\/([a-zA-Z]:)(?:[\\/](.*))?$/.exec(candidate);
  if (leadingSlashDriveMatch !== null) {
    const drive = leadingSlashDriveMatch[1];
    const rest = leadingSlashDriveMatch[2] ?? '';
    if (drive !== undefined) {
      const combined = rest.length > 0 ? `${drive}/${rest}` : `${drive}/`;
      return trimTrailingWinSeparator(path.win32.normalize(combined));
    }
  }

  // Handle standard Windows paths like d:/Code Library/... or C:\Users\...
  if (/^[a-zA-Z]:(?:[\\/]|$)/.test(candidate)) {
    const withSeparator = candidate.length === 2 ? `${candidate}\\` : candidate;
    return trimTrailingWinSeparator(path.win32.normalize(withSeparator));
  }

  if (candidate.startsWith('/')) {
    const posixNormalized = path.posix.normalize(candidate);
    if (posixNormalized.length > 1 && posixNormalized.endsWith('/')) {
      return posixNormalized.slice(0, -1);
    }
    return posixNormalized;
  }

  return path.normalize(candidate);
}

export function getAntigravityScratchDir(): string {
  return normalizeAcpCwd(path.join(os.homedir(), '.gemini', getConfiguredAppDataDir(), 'scratch'));
}

export function isPathEqual(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export function isPathInsideOrEqual(candidatePath: string, parentPath: string): boolean {
  if (candidatePath.length === 0 || parentPath.length === 0) {
    return false;
  }
  if (isPathEqual(candidatePath, parentPath)) {
    return true;
  }
  const pathImpl = process.platform === 'win32' || /^[a-zA-Z]:/.test(parentPath) ? path.win32 : path.posix;
  const normalizedCandidate = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
  const normalizedParent = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath;
  const relative = pathImpl.relative(normalizedParent, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith('..') && !pathImpl.isAbsolute(relative);
}

export function extractSessionIdFromUri(resource: vscode.Uri): string {
  return resource.path.replace(/^\/+/, '');
}

export function buildSessionResource(sessionId: string): vscode.Uri {
  const cleanId = sessionId.replace(/^\/+/, '');
  return vscode.Uri.from({
    scheme: ANTIGRAVITY_SCHEME,
    path: `/${cleanId}`,
  });
}

export class AgySessionController implements vscode.Disposable {
  public readonly controller: vscode.ChatSessionItemController;

  private readonly backend: AcpBackendInterface;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly conversationsDir: string;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly newSessionIds = new Set<string>();
  private readonly untitledToRealId = new Map<string, string>();
  private readonly sessionModes = new Map<string, string>();
  private readonly lastInteractiveModes = new Map<string, string>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, vscode.ChatSessionStatus>();
  private readonly sessionChanges = new Map<string, vscode.ChatSessionFileChange[]>();
  private readonly sessionTitles = new Map<string, string>();
  private readonly sessionInputStates = new Map<string, vscode.ChatSessionInputState>();
  private readonly sideChatMetadataBySessionId = new Map<string, SideChatContextMetadata>();
  private readonly sessionRecentTurnSummaries = new Map<string, string[]>();
  private activeTurnSnapshotProvider: ((sessionId: string) => ActiveTurnSnapshot | undefined) | undefined;

  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightRefresh: Promise<void> | undefined;
  private pendingWatcherRefresh = false;
  private lastWatcherRefreshAt = 0;
  private lastItemsSignature: string | undefined;
  private refreshEpoch = 0;
  private disposed = false;

  public constructor(backend: AcpBackendInterface, outputChannel: vscode.OutputChannel, conversationsDir?: string) {
    this.backend = backend;
    this.outputChannel = outputChannel;
    this.conversationsDir = conversationsDir ?? path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');

    this.controller = vscode.chat.createChatSessionItemController(
      ANTIGRAVITY_SCHEME,
      async (token: vscode.CancellationToken): Promise<void> => {
        await this.refreshSessions(token);
      },
    );

    this.controller.newChatSessionItemHandler = (
      context: NewChatSessionContextWithInputState,
      token: vscode.CancellationToken,
    ): vscode.ChatSessionItem => {
      return this.handleNewChatSessionItem(context, token);
    };

    this.controller.getChatSessionInputState = (
      sessionResource: vscode.Uri | undefined,
      context: { readonly previousInputState?: vscode.ChatSessionInputState | undefined } | undefined,
      token: vscode.CancellationToken,
    ): vscode.ChatSessionInputState => {
      return this.handleGetChatSessionInputState(sessionResource, context, token);
    };

    this.disposables.push(
      this.controller,
      this.backend.onDidChangeBackendState((state) => {
        if (state.ready && !this.disposed) {
          void this.refreshSessions();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!this.disposed) {
          this.lastItemsSignature = undefined;
          this.refreshEpoch++;
          const visibleItems: vscode.ChatSessionItem[] = [];
          this.controller.items.forEach((item) => {
            if (this.matchesWindowCwd(this.sessionCwds.get(extractSessionIdFromUri(item.resource)))) {
              visibleItems.push(item);
            }
          });
          this.controller.items.replace(visibleItems);
          void this.refreshSessions();
        }
      }),
    );

    this.startConversationsWatcher();
  }

  public async refreshSessions(token?: vscode.CancellationToken, fromWatcher = false): Promise<void> {
    if (this.isUnavailable(token)) {
      return;
    }

    if (this.inFlightRefresh !== undefined) {
      if (fromWatcher) {
        this.pendingWatcherRefresh = true;
        return;
      }
      await this.inFlightRefresh;
      if (this.isUnavailable(token)) {
        return;
      }
    }

    const activeRefresh = this.doRefreshSessions(token, fromWatcher);
    this.inFlightRefresh = activeRefresh;
    try {
      await activeRefresh;
    } finally {
      if (this.inFlightRefresh === activeRefresh) {
        this.inFlightRefresh = undefined;
      }
      if (this.pendingWatcherRefresh && !this.disposed) {
        this.pendingWatcherRefresh = false;
        this.scheduleDebouncedRefresh();
      }
    }
  }

  private async doRefreshSessions(token?: vscode.CancellationToken, fromWatcher = false): Promise<void> {
    if (this.isUnavailable(token)) {
      return;
    }

    if (!fromWatcher) {
      this.lastItemsSignature = undefined;
    }

    const currentEpoch = ++this.refreshEpoch;
    let summaries: AcpSessionSummary[];
    try {
      const result = await this.backend.listSessions();
      summaries = result.sessions;
    } catch (error: unknown) {
      this.outputChannel.appendLine(`[AgySessionController] Failed to list sessions: ${formatError(error)}`);
      return;
    }

    if (fromWatcher) {
      this.lastWatcherRefreshAt = Date.now();
    }

    if (this.isUnavailable(token) || currentEpoch !== this.refreshEpoch) {
      return;
    }

    const sortedSummaries = [...summaries].sort((left, right) => {
      const leftMs = parseTimestampMs(left.updatedAt) ?? 0;
      const rightMs = parseTimestampMs(right.updatedAt) ?? 0;
      return rightMs - leftMs;
    });

    const items: vscode.ChatSessionItem[] = [];
    const seenIds = new Set<string>();

    for (const summary of sortedSummaries) {
      if (summary.sessionId.length === 0 || seenIds.has(summary.sessionId)) {
        continue;
      }
      seenIds.add(summary.sessionId);
      const cwd = typeof summary.cwd === 'string' ? normalizeAcpCwd(summary.cwd) : undefined;
      if (cwd === undefined) {
        this.sessionCwds.delete(summary.sessionId);
      } else {
        this.sessionCwds.set(summary.sessionId, cwd);
      }
      if (!this.matchesWindowCwd(cwd)) {
        continue;
      }
      items.push(this.mapSummaryToItem(summary));
    }

    for (const untitledId of this.newSessionIds) {
      if (this.untitledToRealId.has(untitledId) || !this.matchesWindowCwd(this.sessionCwds.get(untitledId))) {
        continue;
      }
      const existingUntitled = this.controller.items.get(buildSessionResource(untitledId));
      if (existingUntitled !== undefined) {
        items.unshift(existingUntitled);
      }
    }

    const nextSignature = buildItemsSignature(items);
    if (this.lastItemsSignature !== undefined && nextSignature === this.lastItemsSignature) {
      return;
    }
    this.lastItemsSignature = nextSignature;
    this.controller.items.replace(items);
  }

  public isNewSession(sessionId: string): boolean {
    if (this.untitledToRealId.has(sessionId)) {
      return false;
    }
    if (this.newSessionIds.has(sessionId)) {
      return true;
    }
    return sessionId.startsWith('untitled-');
  }

  public resolveSessionId(sessionId: string): string {
    return this.untitledToRealId.get(sessionId) ?? sessionId;
  }

  public markSessionRealized(untitledId: string, realSessionId: string): void {
    this.newSessionIds.delete(untitledId);
    this.untitledToRealId.set(untitledId, realSessionId);

    const mode = this.sessionModes.get(untitledId);
    if (mode !== undefined && !this.sessionModes.has(realSessionId)) {
      this.sessionModes.set(realSessionId, mode);
    }

    const lastInteractive = this.lastInteractiveModes.get(untitledId);
    if (lastInteractive !== undefined && !this.lastInteractiveModes.has(realSessionId)) {
      this.lastInteractiveModes.set(realSessionId, lastInteractive);
    }

    const cwd = this.sessionCwds.get(untitledId);
    if (cwd !== undefined && !this.sessionCwds.has(realSessionId)) {
      this.sessionCwds.set(realSessionId, cwd);
    }

    const status = this.sessionStatuses.get(untitledId);
    if (status !== undefined && !this.sessionStatuses.has(realSessionId)) {
      this.sessionStatuses.set(realSessionId, status);
    }

    const changes = this.sessionChanges.get(untitledId);
    if (changes !== undefined && !this.sessionChanges.has(realSessionId)) {
      this.sessionChanges.set(realSessionId, [...changes]);
    }

    const title = this.sessionTitles.get(untitledId);
    if (title !== undefined && !this.sessionTitles.has(realSessionId)) {
      this.sessionTitles.set(realSessionId, title);
    }

    const inputState = this.sessionInputStates.get(untitledId);
    if (inputState !== undefined && !this.sessionInputStates.has(realSessionId)) {
      this.sessionInputStates.set(realSessionId, inputState);
    }

    const sideChatMeta = this.sideChatMetadataBySessionId.get(untitledId);
    if (sideChatMeta !== undefined && !this.sideChatMetadataBySessionId.has(realSessionId)) {
      this.sideChatMetadataBySessionId.set(realSessionId, sideChatMeta);
      this.sideChatMetadataBySessionId.delete(untitledId);
    }

    const untitledResource = buildSessionResource(untitledId);
    const untitledItem = this.controller.items.get(untitledResource);
    const realResource = buildSessionResource(realSessionId);
    const existingRealItem = this.controller.items.get(realResource);

    const resolvedLabel =
      existingRealItem?.label ??
      untitledItem?.label ??
      this.sessionTitles.get(realSessionId) ??
      'New Antigravity Session';

    const targetItem = existingRealItem ?? this.controller.createChatSessionItem(realResource, resolvedLabel);
    targetItem.label = resolvedLabel;
    targetItem.iconPath = untitledItem?.iconPath ?? new vscode.ThemeIcon('antigravity-logo');

    const resolvedCwd = this.sessionCwds.get(realSessionId);
    if (resolvedCwd !== undefined && resolvedCwd.length > 0) {
      applyLocationToItem(targetItem, resolvedLabel, resolvedCwd);
    } else if (untitledItem?.description !== undefined) {
      targetItem.description = untitledItem.description;
    }

    const resolvedStatus = this.sessionStatuses.get(realSessionId) ?? untitledItem?.status;
    if (resolvedStatus !== undefined) {
      targetItem.status = resolvedStatus;
    }

    const resolvedChanges = this.sessionChanges.get(realSessionId) ?? untitledItem?.changes;
    if (resolvedChanges !== undefined) {
      targetItem.changes = [...resolvedChanges];
    }

    if (untitledItem?.timing !== undefined && targetItem.timing === undefined) {
      targetItem.timing = { ...untitledItem.timing };
    }

    this.lastItemsSignature = undefined;
    if (this.matchesWindowCwd(resolvedCwd)) {
      this.controller.items.add(targetItem);
    }
    if (untitledId !== realSessionId) {
      this.controller.items.delete(untitledResource);
    }
  }

  public setSessionStatus(sessionId: string, status: vscode.ChatSessionStatus): void {
    const resolvedId = this.resolveSessionId(sessionId);
    this.sessionStatuses.set(resolvedId, status);
    if (resolvedId !== sessionId) {
      this.sessionStatuses.set(sessionId, status);
    }

    const now = Date.now();
    this.applyToSessionItems(sessionId, resolvedId, (item) => {
      item.status = status;
      const existingTiming = item.timing ?? { created: now };
      if (status === vscode.ChatSessionStatus.InProgress) {
        item.timing = {
          ...existingTiming,
          lastRequestStarted: now,
        };
      } else if (status === vscode.ChatSessionStatus.Completed || status === vscode.ChatSessionStatus.Failed) {
        item.timing = {
          ...existingTiming,
          lastRequestEnded: now,
        };
      }
    });
  }

  public recordFileChange(sessionId: string, change: vscode.ChatSessionFileChange): void {
    const resolvedId = this.resolveSessionId(sessionId);
    const existingList = this.sessionChanges.get(resolvedId) ?? [];
    const targetKey = change.modifiedUri.toString();
    const updatedList: vscode.ChatSessionFileChange[] = [];
    let merged = false;

    for (const entry of existingList) {
      if (entry.modifiedUri.toString() === targetKey) {
        const originalUri = entry.originalUri ?? change.originalUri;
        updatedList.push({
          uri: change.uri,
          modifiedUri: change.modifiedUri,
          ...(originalUri !== undefined ? { originalUri } : {}),
          insertions: entry.insertions + change.insertions,
          deletions: entry.deletions + change.deletions,
        });
        merged = true;
      } else {
        updatedList.push(entry);
      }
    }

    if (!merged) {
      updatedList.push(change);
    }

    this.sessionChanges.set(resolvedId, updatedList);
    if (resolvedId !== sessionId) {
      this.sessionChanges.set(sessionId, [...updatedList]);
    }

    this.applyToSessionItems(sessionId, resolvedId, (item) => {
      item.changes = [...updatedList];
    });
  }

  public setSessionChanges(sessionId: string, changes: readonly vscode.ChatSessionFileChange[]): void {
    const resolvedId = this.resolveSessionId(sessionId);
    const copy = [...changes];
    this.sessionChanges.set(resolvedId, copy);
    if (resolvedId !== sessionId) {
      this.sessionChanges.set(sessionId, [...copy]);
    }

    this.applyToSessionItems(sessionId, resolvedId, (item) => {
      item.changes = [...copy];
    });
  }

  public getSessionMode(sessionId: string): string {
    const resolvedId = this.resolveSessionId(sessionId);
    const stored = this.sessionModes.get(resolvedId) ?? this.sessionModes.get(sessionId);
    if (stored !== undefined && stored.length > 0) {
      return stored;
    }
    return this.getDefaultMode();
  }

  public getLastInteractiveMode(sessionId?: string): string {
    if (sessionId !== undefined && sessionId.length > 0) {
      const resolvedId = this.resolveSessionId(sessionId);
      const stored = this.lastInteractiveModes.get(resolvedId) ?? this.lastInteractiveModes.get(sessionId);
      if (stored !== undefined && stored.length > 0 && stored !== 'plan') {
        return stored;
      }
      const currentMode = this.sessionModes.get(resolvedId) ?? this.sessionModes.get(sessionId);
      if (currentMode !== undefined && currentMode.length > 0 && currentMode !== 'plan') {
        return currentMode;
      }
    }
    return this.getDefaultInteractiveMode();
  }

  public setSessionMode(sessionId: string, mode: string, syncInputState = true): void {
    if (mode.length === 0) {
      return;
    }
    const resolvedId = this.resolveSessionId(sessionId);
    this.sessionModes.set(resolvedId, mode);
    if (resolvedId !== sessionId) {
      this.sessionModes.set(sessionId, mode);
    }
    if (mode !== 'plan') {
      this.lastInteractiveModes.set(resolvedId, mode);
      if (resolvedId !== sessionId) {
        this.lastInteractiveModes.set(sessionId, mode);
      }
    }
    if (syncInputState) {
      this.syncInputStateSelection(sessionId, resolvedId, 'mode', mode);
    }
  }

  public async getSessionCwd(sessionId: string): Promise<string> {
    const resolvedId = this.resolveSessionId(sessionId);
    if (!this.sessionCwds.has(resolvedId)) {
      if (this.isNewSession(resolvedId)) {
        this.sessionCwds.set(resolvedId, this.getDefaultWorkspaceCwd());
      } else {
        await this.refreshSessions();
      }
    }
    const cwd = this.sessionCwds.get(resolvedId);
    if (cwd === undefined || !this.matchesWindowCwd(cwd)) {
      throw new Error(
        'This Antigravity session does not belong to the current VS Code window. Open its project folder to continue.',
      );
    }
    return cwd;
  }

  public setSessionCwd(sessionId: string, rawFolder: string): void {
    const normalized = normalizeAcpCwd(rawFolder);
    if (normalized.length === 0) {
      return;
    }
    const resolvedCwd = this.resolveFolderSelection(normalized);
    const resolvedId = this.resolveSessionId(sessionId);
    this.sessionCwds.set(resolvedId, resolvedCwd);
    if (resolvedId !== sessionId) {
      this.sessionCwds.set(sessionId, resolvedCwd);
    }
    const label = this.getSessionTitle(sessionId) ?? 'New Antigravity Session';
    this.applyToSessionItems(sessionId, resolvedId, (item) => {
      applyLocationToItem(item, label, resolvedCwd);
    });
  }

  public getSessionTitle(sessionId: string): string | undefined {
    const resolvedId = this.resolveSessionId(sessionId);
    return this.sessionTitles.get(resolvedId) ?? this.sessionTitles.get(sessionId);
  }

  public updateSessionMetadata(sessionId: string, metadata: { readonly title?: string | undefined }): void {
    const resolvedId = this.resolveSessionId(sessionId);
    if (metadata.title !== undefined && metadata.title.trim().length > 0) {
      const cleanTitle = metadata.title.trim();
      this.sessionTitles.set(resolvedId, cleanTitle);
      if (resolvedId !== sessionId) {
        this.sessionTitles.set(sessionId, cleanTitle);
      }
      this.applyToSessionItems(sessionId, resolvedId, (item) => {
        item.label = cleanTitle;
      });
    }
  }

  public registerActiveTurnSnapshotProvider(provider: (sessionId: string) => ActiveTurnSnapshot | undefined): void {
    this.activeTurnSnapshotProvider = provider;
  }

  public recordTurnContext(sessionId: string, userPrompt: string, assistantResponse: string): void {
    const resolvedId = this.resolveSessionId(sessionId);
    const trimmedPrompt = userPrompt.trim();
    const trimmedResponse = assistantResponse.trim();
    if (trimmedPrompt.length === 0 && trimmedResponse.length === 0) {
      return;
    }
    const existing = this.sessionRecentTurnSummaries.get(resolvedId) ?? [];
    const entry = [
      trimmedPrompt.length > 0 ? `User: ${trimmedPrompt.slice(0, 600)}` : '',
      trimmedResponse.length > 0 ? `Assistant: ${trimmedResponse.slice(0, 1200)}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
    const updated = [...existing, entry].slice(-3);
    this.sessionRecentTurnSummaries.set(resolvedId, updated);
  }

  public async createForkOrSideChatSession(
    sessionResource: vscode.Uri,
    request: vscode.ChatRequestTurn | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionItem> {
    if (token.isCancellationRequested) {
      throw new Error('Canceled');
    }

    const rawSourceId = extractSessionIdFromUri(sessionResource);
    const sourceSessionId = this.resolveSessionId(rawSourceId);
    const parsedPayload = parseSideChatRequestPayload(request?.prompt);
    const isSideChat = request?.command === 'btw' || parsedPayload?.sideChat === true;

    let cwd = this.getDefaultWorkspaceCwd();
    try {
      cwd = await this.getSessionCwd(sourceSessionId);
    } catch {
      // Fall back to default workspace cwd
    }

    const inFlightSnapshot = this.activeTurnSnapshotProvider?.(sourceSessionId);
    let forkedNewId: string | undefined;
    if (
      !this.isNewSession(sourceSessionId) &&
      inFlightSnapshot === undefined &&
      this.backend.forkConversation !== undefined
    ) {
      try {
        const forked = await this.backend.forkConversation(sourceSessionId);
        forkedNewId = forked?.newCascadeId;
      } catch (error: unknown) {
        this.outputChannel.appendLine(
          `[AgySessionController] ForkConversation failed for ${sourceSessionId}: ${formatError(error)}`,
        );
      }
    }

    const newSessionId =
      forkedNewId !== undefined && forkedNewId.length > 0 ? forkedNewId : `untitled-${crypto.randomUUID()}`;
    if (forkedNewId === undefined || forkedNewId.length === 0) {
      this.newSessionIds.add(newSessionId);
    }
    this.sessionCwds.set(newSessionId, cwd);
    const inheritedMode = this.getSessionMode(sourceSessionId);
    this.sessionModes.set(newSessionId, inheritedMode);
    this.lastInteractiveModes.set(newSessionId, this.getLastInteractiveMode(sourceSessionId));

    const sourceTitle = this.getSessionTitle(sourceSessionId) ?? 'Antigravity Session';
    const label = isSideChat ? `Side Chat: ${sourceTitle}` : `Fork: ${sourceTitle}`;
    this.sessionTitles.set(newSessionId, label);

    if (isSideChat) {
      this.sideChatMetadataBySessionId.set(newSessionId, {
        sourceSessionId,
        turnId: parsedPayload?.turnId,
        selection: parsedPayload?.selection,
        includeSourceContext: parsedPayload?.includeSourceContext !== false,
        inFlightSnapshot,
        forkedFromBackend: forkedNewId !== undefined && forkedNewId.length > 0,
        contextInjected: false,
      });
    }

    const resource = buildSessionResource(newSessionId);
    const item = this.controller.createChatSessionItem(resource, label);
    item.iconPath = new vscode.ThemeIcon(isSideChat ? 'comment-discussion' : 'antigravity-logo');
    const now = Date.now();
    item.timing = { created: now, lastRequestStarted: now, lastRequestEnded: now };
    applyLocationToItem(item, label, cwd);

    this.lastItemsSignature = undefined;
    if (this.matchesWindowCwd(cwd)) {
      this.controller.items.add(item);
    }
    return item;
  }

  public consumeSideChatPreamble(sessionId: string): string | undefined {
    const resolvedId = this.resolveSessionId(sessionId);
    const meta = this.sideChatMetadataBySessionId.get(resolvedId) ?? this.sideChatMetadataBySessionId.get(sessionId);
    if (meta === undefined || meta.contextInjected) {
      return undefined;
    }
    meta.contextInjected = true;

    const sections: string[] = [];
    if (meta.includeSourceContext) {
      if (!meta.forkedFromBackend) {
        const recent = this.sessionRecentTurnSummaries.get(meta.sourceSessionId);
        if (recent !== undefined && recent.length > 0) {
          sections.push(`<recent_main_turns>\n${recent.join('\n---\n')}\n</recent_main_turns>`);
        }
      }
      if (meta.inFlightSnapshot !== undefined) {
        const promptPart = meta.inFlightSnapshot.userPrompt.trim();
        const responsePart = meta.inFlightSnapshot.assistantPartialResponse.trim();
        sections.push(
          [
            '<in_flight_main_turn>',
            ...(promptPart.length > 0 ? [`User request currently running in main session:\n${promptPart}`] : []),
            ...(responsePart.length > 0 ? [`Assistant response so far:\n${responsePart}`] : []),
            '</in_flight_main_turn>',
          ].join('\n'),
        );
      }
    }

    if (meta.selection !== undefined && meta.selection.trim().length > 0) {
      sections.push(`<selected_excerpt>\n${meta.selection.trim()}\n</selected_excerpt>`);
    }

    sections.push(
      "[Side Chat (/btw): Answer the user's side question concisely and accurately using the context above, without modifying unrelated task flow in the main session.]",
    );
    return sections.join('\n\n');
  }

  public async handleEditingAction(sessionResourceRaw: unknown, actionRaw: unknown): Promise<void> {
    const sessionUri = toUriFromUnknown(sessionResourceRaw);
    if (sessionUri === undefined || sessionUri.scheme !== ANTIGRAVITY_SCHEME) {
      return;
    }
    const rawSessionId = extractSessionIdFromUri(sessionUri);
    const resolvedId = this.resolveSessionId(rawSessionId);
    const action = isRecordObject(actionRaw) ? (actionRaw as EditingActionNotification) : undefined;
    const outcome = action?.outcome;
    const fileUri = toUriFromUnknown(action?.uri);

    if (outcome === 'rejected' && action?.hasRemainingEdits !== true && fileUri !== undefined) {
      const targetStr = fileUri.toString();
      const existing = this.sessionChanges.get(resolvedId);
      if (existing !== undefined) {
        const filtered = existing.filter((entry) => entry.modifiedUri.toString() !== targetStr);
        if (filtered.length !== existing.length) {
          this.setSessionChanges(resolvedId, filtered);
        }
      }
    }

    if (
      (outcome === 'accepted' || outcome === 'rejected') &&
      fileUri !== undefined &&
      this.backend.acknowledgeCodeEdit !== undefined &&
      !this.isNewSession(resolvedId)
    ) {
      let contents = '';
      if (fileUri.scheme === 'file' && fileUri.fsPath.length > 0) {
        try {
          contents = await fsPromises.readFile(fileUri.fsPath, 'utf8');
        } catch {
          contents = '';
        }
      }
      void this.backend
        .acknowledgeCodeEdit(resolvedId, fileUri.toString(), contents, outcome === 'accepted')
        .catch(() => {
          /* best-effort acknowledgement */
        });
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.watcher !== undefined) {
      this.watcher.close();
      this.watcher = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;

    this.newSessionIds.clear();
    this.untitledToRealId.clear();
    this.sessionModes.clear();
    this.lastInteractiveModes.clear();
    this.sessionCwds.clear();
    this.sessionStatuses.clear();
    this.sessionChanges.clear();
    this.sessionTitles.clear();
    this.sessionInputStates.clear();
    this.sideChatMetadataBySessionId.clear();
    this.sessionRecentTurnSummaries.clear();
  }

  private handleNewChatSessionItem(
    context: NewChatSessionContextWithInputState,
    _token: vscode.CancellationToken,
  ): vscode.ChatSessionItem {
    const initialOptions = extractInitialOptions(context);
    const normalizedFolder =
      initialOptions.folder !== undefined && initialOptions.folder.length > 0
        ? normalizeAcpCwd(initialOptions.folder)
        : '';
    const resolvedCwd =
      normalizedFolder.length > 0 ? this.resolveFolderSelection(normalizedFolder) : this.getDefaultWorkspaceCwd();
    const untitledId = `untitled-${crypto.randomUUID()}`;
    this.newSessionIds.add(untitledId);
    this.sessionCwds.set(untitledId, resolvedCwd);

    const promptText = context.request.prompt.trim();
    const label = promptText.length > 0 ? truncateTitle(promptText) : 'New Antigravity Session';
    this.sessionTitles.set(untitledId, label);

    if (initialOptions.mode !== undefined && initialOptions.mode.length > 0) {
      this.sessionModes.set(untitledId, initialOptions.mode);
      if (initialOptions.mode !== 'plan') {
        this.lastInteractiveModes.set(untitledId, initialOptions.mode);
      }
    }

    const resource = buildSessionResource(untitledId);
    const item = this.controller.createChatSessionItem(resource, label);
    item.iconPath = new vscode.ThemeIcon('antigravity-logo');
    item.status = vscode.ChatSessionStatus.InProgress;
    item.timing = { created: Date.now() };

    applyLocationToItem(item, label, resolvedCwd);

    this.lastItemsSignature = undefined;
    this.controller.items.add(item);
    return item;
  }

  private isAgentSessionsWindow(): boolean {
    return (vscode.workspace as { readonly isAgentSessionsWorkspace?: boolean }).isAgentSessionsWorkspace === true;
  }

  private resolveFolderSelection(normalizedFolder: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return this.isAgentSessionsWindow() ? normalizedFolder : '';
    }
    const matchedFolder = workspaceFolders.find((folder) => {
      if (folder.uri.scheme !== 'file') {
        return false;
      }
      const root = normalizeAcpCwd(folder.uri.fsPath);
      return root.length > 0 && isPathInsideOrEqual(normalizedFolder, root);
    });
    return matchedFolder !== undefined ? normalizeAcpCwd(matchedFolder.uri.fsPath) : this.getDefaultWorkspaceCwd();
  }

  private matchesWindowCwd(cwd: string | undefined): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    return workspaceFolders.length === 0
      ? this.isAgentSessionsWindow()
        ? cwd !== undefined
        : cwd === ''
      : cwd !== undefined &&
          workspaceFolders.some(
            (folder) => folder.uri.scheme === 'file' && isPathEqual(cwd, normalizeAcpCwd(folder.uri.fsPath)),
          );
  }

  private handleGetChatSessionInputState(
    sessionResource: vscode.Uri | undefined,
    context: { readonly previousInputState?: vscode.ChatSessionInputState | undefined } | undefined,
    _token: vscode.CancellationToken,
  ): vscode.ChatSessionInputState {
    const rawSessionId = sessionResource !== undefined ? extractSessionIdFromUri(sessionResource) : undefined;
    const resolvedId = rawSessionId !== undefined ? this.resolveSessionId(rawSessionId) : undefined;

    const prevGroups = context?.previousInputState?.groups;
    const prevMode = prevGroups !== undefined ? findSelectedOptionId(prevGroups, 'mode') : undefined;

    const selectedMode =
      resolvedId !== undefined
        ? (this.sessionModes.get(resolvedId) ?? prevMode ?? this.getDefaultMode())
        : (prevMode ?? this.getDefaultMode());
    const groups = [this.buildModeGroup(selectedMode, resolvedId ?? rawSessionId)];

    const inputState = this.controller.createChatSessionInputState(groups);
    if (rawSessionId !== undefined) {
      this.sessionInputStates.set(rawSessionId, inputState);
      if (resolvedId !== undefined && resolvedId !== rawSessionId) {
        this.sessionInputStates.set(resolvedId, inputState);
      }
      const disposeSub = inputState.onDidDispose(() => {
        if (this.sessionInputStates.get(rawSessionId) === inputState) {
          this.sessionInputStates.delete(rawSessionId);
        }
        if (resolvedId !== undefined && this.sessionInputStates.get(resolvedId) === inputState) {
          this.sessionInputStates.delete(resolvedId);
        }
        disposeSub.dispose();
      });
    }

    return inputState;
  }

  private buildModeGroup(selectedModeId: string, sessionId?: string): vscode.ChatSessionProviderOptionGroup {
    const mode = this.backend.getLastKnownConfigOptions().find((option) => option.id === 'mode');
    const choices =
      mode !== undefined && mode.options.length > 0
        ? mode.options.map((choice) => {
            const known = MODE_OPTIONS.find((option) => option.id === choice.value);
            return {
              id: choice.value,
              name: choice.name,
              description: choice.description ?? known?.description,
              icon: known?.icon ?? 'settings-sliders',
            };
          })
        : MODE_OPTIONS;
    const effectiveSelectedId = selectedModeId.length > 0 ? selectedModeId : (mode?.currentValue ?? 'default');
    const lastInteractiveMode =
      effectiveSelectedId !== 'plan' ? effectiveSelectedId : this.getLastInteractiveMode(sessionId);
    const items: AgyChatSessionProviderOptionItem[] = choices.map((option) => ({
      id: option.id,
      name: option.name,
      ...(option.description !== undefined ? { description: option.description } : {}),
      icon: new vscode.ThemeIcon(option.icon),
      agyPickerMeta: buildModePickerMeta(option.id, option.name, option.description, lastInteractiveMode),
    }));

    const selected =
      items.find((item) => item.id === selectedModeId) ??
      items.find((item) => item.id === mode?.currentValue) ??
      items[0];
    return {
      id: 'mode',
      name: 'Agent Mode',
      description: 'Execution and permission mode',
      items,
      ...(selected !== undefined ? { selected } : {}),
      icon: new vscode.ThemeIcon('settings-sliders'),
    };
  }

  private mapSummaryToItem(summary: AcpSessionSummary): vscode.ChatSessionItem {
    const resource = buildSessionResource(summary.sessionId);
    const trimmedTitle = summary.title?.trim();
    const label =
      trimmedTitle !== undefined && trimmedTitle.length > 0
        ? trimmedTitle
        : (this.sessionTitles.get(summary.sessionId) ?? 'Antigravity Session');

    this.sessionTitles.set(summary.sessionId, label);

    const normalizedCwd = normalizeAcpCwd(summary.cwd);
    const item = this.controller.createChatSessionItem(resource, label);
    item.iconPath = new vscode.ThemeIcon('antigravity-logo');
    item.status = this.sessionStatuses.get(summary.sessionId) ?? vscode.ChatSessionStatus.Completed;

    applyLocationToItem(item, label, normalizedCwd);

    const updatedMs = parseTimestampMs(summary.updatedAt);
    if (updatedMs !== undefined) {
      item.timing = {
        created: updatedMs,
        lastRequestEnded: updatedMs,
      };
    }

    const cachedChanges = this.sessionChanges.get(summary.sessionId);
    if (cachedChanges !== undefined) {
      item.changes = [...cachedChanges];
    }

    return item;
  }

  private applyToSessionItems(
    rawId: string,
    resolvedId: string,
    updater: (item: vscode.ChatSessionItem) => void,
  ): void {
    this.lastItemsSignature = undefined;
    const primary = this.controller.items.get(buildSessionResource(resolvedId));
    if (primary !== undefined) {
      updater(primary);
    }
    if (rawId !== resolvedId) {
      const secondary = this.controller.items.get(buildSessionResource(rawId));
      if (secondary !== undefined) {
        updater(secondary);
      }
    }
  }

  private syncInputStateSelection(rawId: string, resolvedId: string, groupId: string, optionValue: string): void {
    const candidates = new Set<vscode.ChatSessionInputState>();
    const byRaw = this.sessionInputStates.get(rawId);
    if (byRaw !== undefined) {
      candidates.add(byRaw);
    }
    const byResolved = this.sessionInputStates.get(resolvedId);
    if (byResolved !== undefined) {
      candidates.add(byResolved);
    }

    for (const inputState of candidates) {
      let changed = false;
      const nextGroups: vscode.ChatSessionProviderOptionGroup[] = [];
      for (const group of inputState.groups) {
        if (group.id !== groupId) {
          nextGroups.push(group);
          continue;
        }
        const matched = group.items.find((item) => item.id === optionValue);
        if (matched === undefined || group.selected?.id === matched.id) {
          nextGroups.push(group);
          continue;
        }
        changed = true;
        if (groupId === 'mode') {
          nextGroups.push(this.buildModeGroup(matched.id, resolvedId));
        } else {
          nextGroups.push({
            ...group,
            selected: matched,
          });
        }
      }
      if (changed) {
        inputState.groups = nextGroups;
      }
    }
  }

  private startConversationsWatcher(): void {
    try {
      if (!fs.existsSync(this.conversationsDir)) {
        this.outputChannel.appendLine(
          `[AgySessionController] Conversations directory does not exist yet: ${this.conversationsDir}`,
        );
        return;
      }

      this.watcher = fs.watch(this.conversationsDir, { persistent: false }, (_eventType, filename) => {
        if (!isTransientConversationFile(filename)) {
          this.scheduleDebouncedRefresh();
        }
      });
      this.watcher.on('error', (error: Error) => {
        this.outputChannel.appendLine(`[AgySessionController] File watcher warning: ${error.message}`);
      });
    } catch (error: unknown) {
      this.outputChannel.appendLine(
        `[AgySessionController] Could not watch conversations directory: ${formatError(error)}`,
      );
    }
  }

  private scheduleDebouncedRefresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    const elapsedMs = Date.now() - this.lastWatcherRefreshAt;
    const waitMs = Math.max(WATCH_DEBOUNCE_MS, MIN_WATCHER_REFRESH_INTERVAL_MS - elapsedMs);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.disposed) {
        void this.refreshSessions(undefined, true);
      }
    }, waitMs);
    this.debounceTimer.unref();
  }

  private getDefaultMode(): string {
    try {
      const configured = vscode.workspace.getConfiguration('antigravityHarness').get<string>('defaultMode');
      if (configured !== undefined && configured.length > 0) {
        return configured;
      }
    } catch (error: unknown) {
      this.outputChannel.appendLine(`[AgySessionController] Failed reading defaultMode config: ${formatError(error)}`);
    }
    return 'default';
  }

  private getDefaultInteractiveMode(): string {
    const defaultMode = this.getDefaultMode();
    return defaultMode !== 'plan' ? defaultMode : 'default';
  }

  private getDefaultWorkspaceCwd(): string {
    const firstWorkspace = vscode.workspace.workspaceFolders?.[0];
    if (firstWorkspace === undefined) {
      return '';
    }
    if (firstWorkspace.uri.scheme !== 'file') {
      throw new Error('Antigravity requires a local project folder.');
    }
    return normalizeAcpCwd(firstWorkspace.uri.fsPath);
  }

  private isUnavailable(token?: vscode.CancellationToken): boolean {
    return this.disposed || token?.isCancellationRequested === true;
  }
}

interface NewChatSessionContextWithInputState extends vscode.NewChatSessionItemContext {
  readonly inputState?: vscode.ChatSessionInputState | undefined;
}

function parseFileUriToPath(uriString: string): string {
  try {
    const parsed = new URL(uriString);
    const decodedPathname = decodePercentSequences(parsed.pathname);
    if (parsed.hostname.length > 0 && parsed.hostname.toLowerCase() !== 'localhost') {
      return `//${parsed.hostname}${decodedPathname}`;
    }
    return decodedPathname;
  } catch {
    return decodePercentSequences(uriString.replace(/^file:\/\//i, ''));
  }
}

function decodePercentSequences(input: string): string {
  return input.replace(/(?:%[0-9A-Fa-f]{2})+/g, (sequence) => {
    try {
      return decodeURIComponent(sequence);
    } catch {
      return sequence;
    }
  });
}

function trimTrailingWinSeparator(winPath: string): string {
  if (/^[a-zA-Z]:\\$/.test(winPath)) {
    return winPath;
  }
  if (/^\\\\[^\\]+\\[^\\]+\\$/.test(winPath)) {
    return winPath.slice(0, -1);
  }
  if (winPath.length > 3 && winPath.endsWith('\\')) {
    return winPath.slice(0, -1);
  }
  return winPath;
}

function getFolderBasename(folderPath: string): string {
  const isWindows = /^[a-zA-Z]:/.test(folderPath) || folderPath.includes('\\');
  const base = isWindows ? path.win32.basename(folderPath) : path.posix.basename(folderPath);
  return base.length > 0 ? base : folderPath;
}

function truncateTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0]?.trim() ?? '';
  if (firstLine.length === 0) {
    return 'New Antigravity Session';
  }
  if (firstLine.length <= MAX_TITLE_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function parseTimestampMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function extractInitialOptions(context: NewChatSessionContextWithInputState): {
  readonly mode?: string | undefined;
  readonly folder?: string | undefined;
} {
  let mode: string | undefined;
  let folder: string | undefined;

  if (context.sessionOptions !== undefined) {
    for (const option of context.sessionOptions) {
      const value = typeof option.value === 'string' ? option.value : option.value.id;
      if (option.optionId === 'mode') {
        mode = value;
      } else if (option.optionId === 'folder') {
        folder = value;
      }
    }
  }

  if (context.inputState?.groups !== undefined) {
    mode ??= findSelectedOptionId(context.inputState.groups, 'mode');
    folder ??= findSelectedOptionId(context.inputState.groups, 'folder');
  }

  return { mode, folder };
}

function getConfiguredAppDataDir(): string {
  try {
    const configured = vscode.workspace.getConfiguration('antigravityHarness').get<string>('appDataDir')?.trim();
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
  } catch {
    // Fall back to default appDataDir when workspace configuration is unavailable.
  }
  return 'antigravity';
}

function applyLocationToItem(
  item: vscode.ChatSessionItem,
  label: string,
  normalizedCwd: string,
  clearWhenEmpty = false,
): void {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (normalizedCwd === '') {
    delete item.metadata;
    item.description = 'No Project';
    item.tooltip = `${label}\nNo Project`;
    return;
  }

  item.metadata = {
    workingDirectoryPath: normalizedCwd,
    cwd: normalizedCwd,
  };

  if (workspaceFolders.length === 1) {
    const firstFolderPath = normalizeAcpCwd(workspaceFolders[0]?.uri.fsPath ?? '');
    if (firstFolderPath.length > 0 && isPathEqual(normalizedCwd, firstFolderPath)) {
      if (clearWhenEmpty) {
        item.description = '';
      }
      item.tooltip = `${label}\n${normalizedCwd}`;
      return;
    }
    if (firstFolderPath.length > 0 && isPathInsideOrEqual(normalizedCwd, firstFolderPath)) {
      const pathImpl = process.platform === 'win32' || /^[a-zA-Z]:/.test(firstFolderPath) ? path.win32 : path.posix;
      const relative = pathImpl.relative(firstFolderPath, normalizedCwd);
      item.description = relative.length > 0 ? relative : getFolderBasename(normalizedCwd);
      item.tooltip = `${label}\n${normalizedCwd}`;
      return;
    }
  }

  item.description = getFolderBasename(normalizedCwd);
  item.tooltip = `${label}\n${normalizedCwd}`;
}

function findSelectedOptionId(
  groups: readonly vscode.ChatSessionProviderOptionGroup[],
  groupId: string,
): string | undefined {
  const group = groups.find((candidate) => candidate.id === groupId);
  return group?.selected?.id;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildModePickerMeta(
  id: string,
  name: string,
  description: string | undefined,
  lastInteractiveMode: string,
): AgyModePickerMeta {
  const base = {
    provider: 'antigravity' as const,
    lastInteractiveMode,
  };
  switch (id) {
    case 'default':
      return {
        ...base,
        category: 'permission',
        pickerLabel: 'Manual permissions',
        shortLabel: 'Manual',
        detail: description ?? 'Ask before edits and commands',
        tone: '',
      };
    case 'accept-edits':
      return {
        ...base,
        category: 'permission',
        pickerLabel: 'Accept edits',
        shortLabel: 'Accept edits',
        detail: description ?? 'Auto-approve workspace file edits',
        tone: 'info',
      };
    case 'auto':
      return {
        ...base,
        category: 'permission',
        pickerLabel: 'Auto',
        shortLabel: 'Auto',
        detail: description ?? 'Automatically approve one-time tool requests',
        tone: 'warning',
      };
    case 'plan':
      return {
        ...base,
        category: 'mode',
        pickerLabel: 'Plan',
        shortLabel: 'Plan',
        detail: description ?? 'Plan changes before executing',
        tone: '',
      };
    default:
      return {
        ...base,
        category: 'permission',
        pickerLabel: name,
        shortLabel: name,
        detail: description ?? '',
        tone: '',
      };
  }
}

function toUriFromUnknown(raw: unknown): vscode.Uri | undefined {
  if (raw instanceof vscode.Uri) {
    return raw;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return vscode.Uri.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (isRecordObject(raw)) {
    if (typeof raw.fsPath === 'string' && raw.fsPath.length > 0) {
      return vscode.Uri.file(raw.fsPath);
    }
    if (typeof raw.scheme === 'string' && typeof raw.path === 'string') {
      return vscode.Uri.from({
        scheme: raw.scheme,
        path: raw.path,
        ...(typeof raw.authority === 'string' ? { authority: raw.authority } : {}),
        ...(typeof raw.query === 'string' ? { query: raw.query } : {}),
        ...(typeof raw.fragment === 'string' ? { fragment: raw.fragment } : {}),
      });
    }
  }
  return undefined;
}

function parseSideChatRequestPayload(prompt: string | undefined):
  | {
      readonly sideChat?: boolean | undefined;
      readonly turnId?: string | undefined;
      readonly selection?: string | undefined;
      readonly includeSourceContext?: boolean | undefined;
    }
  | undefined {
  if (prompt === undefined || !prompt.trimStart().startsWith('{')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(prompt);
    if (!isRecordObject(parsed)) {
      return undefined;
    }
    return {
      sideChat: typeof parsed.sideChat === 'boolean' ? parsed.sideChat : undefined,
      turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
      selection: typeof parsed.selection === 'string' ? parsed.selection : undefined,
      includeSourceContext: typeof parsed.includeSourceContext === 'boolean' ? parsed.includeSourceContext : undefined,
    };
  } catch {
    return undefined;
  }
}
