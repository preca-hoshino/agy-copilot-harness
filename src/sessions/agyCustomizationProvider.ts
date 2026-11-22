import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpBackendInterface, AgySlashCommandDescriptor } from '../shared/contracts.js';
import { ANTIGRAVITY_SCHEME } from '../shared/contracts.js';
import type { AgySessionController } from './agySessionController.js';
import { extractSessionIdFromUri, normalizeAcpCwd } from './agySessionController.js';

export interface ParsedSkillFrontmatter {
  name?: string | undefined;
  description?: string | undefined;
  userInvocable?: boolean | undefined;
}

const RESERVED_PACKAGE_COMMANDS = new Set(['plan', 'compact', 'btw']);
const MAX_FRONTMATTER_BYTES = 4096;
const LS_COMMAND_CACHE_TTL_MS = 10_000;

function stripOptionalQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSkillFrontmatter(raw: string): ParsedSkillFrontmatter {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (match === null) {
    return {};
  }
  const frontmatter = match[1] ?? '';
  const result: ParsedSkillFrontmatter = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0 || /^\s/.test(line)) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const rawValue = stripOptionalQuotes(line.slice(colonIdx + 1));
    if (key === 'name' && rawValue.length > 0) {
      result.name = rawValue;
    } else if (key === 'description' && rawValue.length > 0) {
      result.description = rawValue;
    } else if (key === 'user-invocable' || key === 'userinvocable') {
      if (rawValue.toLowerCase() === 'false') {
        result.userInvocable = false;
      } else if (rawValue.toLowerCase() === 'true') {
        result.userInvocable = true;
      }
    }
  }
  return result;
}

function toFsPath(filePathOrUri: string): string {
  const trimmed = filePathOrUri.trim();
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return vscode.Uri.parse(trimmed).fsPath;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function normalizePathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isSkillMarkdownPath(filePath: string): boolean {
  const fsPath = toFsPath(filePath);
  const baseName = path.basename(fsPath);
  return baseName.toLowerCase() === 'skill.md';
}

export function resolveSkillDisplayNameSync(filePath: string, cachedNames?: ReadonlyMap<string, string>): string {
  const fsPath = toFsPath(filePath);
  const cacheKey = normalizePathKey(fsPath);
  const cached = cachedNames?.get(cacheKey);
  if (cached !== undefined && cached.length > 0) {
    return cached;
  }

  try {
    const fd = fs.openSync(fsPath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_FRONTMATTER_BYTES, 0);
      if (bytesRead > 0) {
        const parsed = parseSkillFrontmatter(buffer.subarray(0, bytesRead).toString('utf8'));
        if (parsed.name !== undefined && parsed.name.length > 0) {
          return parsed.name;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Fall back to parent directory name if unreadable or missing
  }

  const parentDirName = path.basename(path.dirname(fsPath));
  if (parentDirName.length > 0 && parentDirName !== '.' && parentDirName !== path.sep) {
    return parentDirName;
  }
  return 'skill';
}

export function formatSkillReadMarkdownLink(
  filePath: string,
  skillName: string,
  startLine?: number,
  endLine?: number,
): string {
  const fsPath = toFsPath(filePath);
  const baseUri = /^file:\/\//i.test(filePath.trim()) ? vscode.Uri.parse(filePath.trim()) : vscode.Uri.file(fsPath);
  const escapedUri = baseUri.toString().replace(/#.*$/, '').replace(/\(/g, '%28').replace(/\)/g, '%29');
  const querySeparator = escapedUri.includes('?') ? '&' : '?';
  const uriWithType = `${escapedUri}${querySeparator}vscodeLinkType=skill`;
  const target = startLine !== undefined ? `${uriWithType}#${startLine}-${startLine}` : uriWithType;

  let range = '';
  if (startLine !== undefined) {
    range = endLine !== undefined && endLine > startLine ? `, lines ${startLine} to ${endLine}` : `, line ${startLine}`;
  }
  const escapedLabel = skillName.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  return `[${escapedLabel}](${target})${range}`;
}

function getSkillCustomizationType(): vscode.ChatSessionCustomizationType {
  const typeClass = (vscode as Partial<typeof vscode>).ChatSessionCustomizationType;
  if (typeClass !== undefined) {
    return typeClass.Skill;
  }
  return { id: 'skill' };
}

function isTokenCancelled(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}

function isNonEmptyDir(candidate: string): boolean {
  return candidate.length > 0;
}

interface DiscoveredSkillEntry {
  name: string;
  description?: string | undefined;
  uri: vscode.Uri;
  fsPath: string;
  source: 'workspace' | 'user' | 'builtin';
  userInvocable: boolean;
}

export class AgySkillRegistry implements vscode.Disposable {
  private readonly backend: AcpBackendInterface;
  private readonly controller: AgySessionController;
  private readonly appDataDir: string;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly skillNameByPath = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private cachedLsCommands: AgySlashCommandDescriptor[] = [];
  private lastLsFetchAt = 0;

  public readonly onDidChange: vscode.Event<void> = this.emitter.event;

  public constructor(backend: AcpBackendInterface, controller: AgySessionController, appDataDir = 'antigravity') {
    this.backend = backend;
    this.controller = controller;
    this.appDataDir = appDataDir.trim().length > 0 ? appDataDir.trim() : 'antigravity';

    if (backend.onDidChangeAvailableCommands !== undefined) {
      this.disposables.push(
        backend.onDidChangeAvailableCommands(() => {
          this.lastLsFetchAt = 0;
          this.emitter.fire();
        }),
      );
    }

    const createWatcher = (vscode.workspace as Partial<typeof vscode.workspace>).createFileSystemWatcher;
    if (typeof createWatcher === 'function') {
      const watcher = createWatcher('**/.agents/skills/*/SKILL.md');
      this.disposables.push(
        watcher,
        watcher.onDidCreate(() => {
          this.emitter.fire();
        }),
        watcher.onDidChange(() => {
          this.emitter.fire();
        }),
        watcher.onDidDelete(() => {
          this.emitter.fire();
        }),
      );
    }
  }

  public getCachedSkillName(filePath: string): string | undefined {
    return this.skillNameByPath.get(normalizePathKey(toFsPath(filePath)));
  }

  public async discoverSkills(sessionCwd?: string): Promise<DiscoveredSkillEntry[]> {
    const dirs = this.collectSkillRoots(sessionCwd);
    const seenNames = new Set<string>();
    const results: DiscoveredSkillEntry[] = [];

    for (const { rootDir, source } of dirs) {
      const entries = await this.scanSkillDirectory(rootDir, source);
      for (const entry of entries) {
        this.skillNameByPath.set(normalizePathKey(entry.fsPath), entry.name);
        const dedupKey = entry.name.toLowerCase();
        if (seenNames.has(dedupKey)) {
          continue;
        }
        seenNames.add(dedupKey);
        results.push(entry);
      }
    }
    return results;
  }

  public async provideCustomizations(
    sessionResource: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionCustomizationItem[]> {
    if (isTokenCancelled(token)) {
      return [];
    }

    const rawSessionId = extractSessionIdFromUri(sessionResource);
    const resolvedId = this.controller.resolveSessionId(rawSessionId);
    const sessionCwd = await this.resolveCwdSafe(resolvedId);
    if (isTokenCancelled(token)) {
      return [];
    }

    const skills = await this.discoverSkills(sessionCwd);
    const skillType = getSkillCustomizationType();
    const items: vscode.ChatSessionCustomizationItem[] = [];
    const seenCommandNames = new Set<string>();

    for (const skill of skills) {
      seenCommandNames.add(skill.name.toLowerCase());
      if (!skill.userInvocable) {
        continue;
      }
      items.push({
        uri: skill.uri,
        type: skillType,
        name: skill.name,
        ...(skill.description !== undefined ? { description: skill.description } : {}),
        source: skill.source,
        userInvocable: true,
      });
    }

    const acpAndLsCommands = await this.getCommandsCached(resolvedId, sessionCwd);
    for (const cmd of acpAndLsCommands) {
      const key = cmd.name.toLowerCase();
      if (seenCommandNames.has(key) || RESERVED_PACKAGE_COMMANDS.has(key)) {
        continue;
      }
      seenCommandNames.add(key);
      items.push({
        uri: vscode.Uri.from({
          scheme: ANTIGRAVITY_SCHEME,
          path: `/command/${encodeURIComponent(cmd.name)}`,
        }),
        type: skillType,
        name: cmd.name,
        ...(cmd.description !== undefined ? { description: cmd.description } : {}),
        source: 'user',
        userInvocable: true,
      });
    }

    return items;
  }

  private async resolveCwdSafe(sessionId: string): Promise<string | undefined> {
    if (!this.controller.isNewSession(sessionId)) {
      try {
        return await this.controller.getSessionCwd(sessionId);
      } catch {
        // Fall back to workspace folder below
      }
    }
    const workspaceFolders = (vscode.workspace as Partial<typeof vscode.workspace>).workspaceFolders;
    const firstFolder = workspaceFolders?.[0]?.uri.fsPath;
    return firstFolder !== undefined && firstFolder.length > 0 ? normalizeAcpCwd(firstFolder) : undefined;
  }

  private async getCommandsCached(sessionId: string, sessionCwd?: string): Promise<AgySlashCommandDescriptor[]> {
    const merged = new Map<string, AgySlashCommandDescriptor>();
    for (const cmd of this.backend.getAvailableCommands?.(sessionId) ?? []) {
      merged.set(cmd.name.toLowerCase(), cmd);
    }

    const now = Date.now();
    if (now - this.lastLsFetchAt >= LS_COMMAND_CACHE_TTL_MS && this.backend.fetchSlashCommands !== undefined) {
      const workspaceUris = sessionCwd !== undefined ? [vscode.Uri.file(sessionCwd).toString()] : undefined;
      try {
        this.cachedLsCommands = await this.backend.fetchSlashCommands(workspaceUris, sessionId);
        this.lastLsFetchAt = now;
      } catch {
        // Use cached commands if language server query fails
      }
    }

    for (const cmd of this.cachedLsCommands) {
      const key = cmd.name.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, cmd);
      }
    }
    return Array.from(merged.values());
  }

  private collectSkillRoots(sessionCwd?: string): Array<{ rootDir: string; source: 'workspace' | 'user' | 'builtin' }> {
    const seenRoots = new Set<string>();
    const roots: Array<{ rootDir: string; source: 'workspace' | 'user' | 'builtin' }> = [];
    const addRoot = (candidate: string, source: 'workspace' | 'user' | 'builtin'): void => {
      if (!isNonEmptyDir(candidate)) {
        return;
      }
      const key = normalizePathKey(candidate);
      if (seenRoots.has(key)) {
        return;
      }
      seenRoots.add(key);
      roots.push({ rootDir: candidate, source });
    };

    const workspaceStarts: string[] = [];
    if (sessionCwd !== undefined && sessionCwd.length > 0) {
      workspaceStarts.push(sessionCwd);
    }
    const workspaceFolders = (vscode.workspace as Partial<typeof vscode.workspace>).workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
      if (folder.uri.scheme === 'file' && folder.uri.fsPath.length > 0) {
        workspaceStarts.push(folder.uri.fsPath);
      }
    }

    for (const startDir of workspaceStarts) {
      for (let current = path.resolve(startDir); ; ) {
        addRoot(path.join(current, '.agents', 'skills'), 'workspace');
        const parent = path.dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }

    const geminiRoot = path.join(os.homedir(), '.gemini');
    const resolvedAppDataDir = path.isAbsolute(this.appDataDir)
      ? this.appDataDir
      : path.join(geminiRoot, this.appDataDir);
    addRoot(path.join(resolvedAppDataDir, 'skills'), 'user');
    addRoot(path.join(geminiRoot, 'config', 'skills'), 'user');
    addRoot(path.join(os.homedir(), '.agents', 'skills'), 'user');
    addRoot(path.join(resolvedAppDataDir, 'builtin', 'skills'), 'builtin');

    return roots;
  }

  private async scanSkillDirectory(
    rootDir: string,
    source: 'workspace' | 'user' | 'builtin',
  ): Promise<DiscoveredSkillEntry[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const discovered: DiscoveredSkillEntry[] = [];
    for (const dirent of entries) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const skillFilePath = path.join(rootDir, dirent.name, 'SKILL.md');
      try {
        const handle = await fsPromises.open(skillFilePath, 'r');
        let raw = '';
        try {
          const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
          const readResult = await handle.read(buffer, 0, MAX_FRONTMATTER_BYTES, 0);
          raw = buffer.subarray(0, readResult.bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
        const parsed = parseSkillFrontmatter(raw);
        const name = parsed.name !== undefined && parsed.name.length > 0 ? parsed.name : dirent.name;
        discovered.push({
          name,
          description: parsed.description,
          uri: vscode.Uri.file(skillFilePath),
          fsPath: skillFilePath,
          source,
          userInvocable: parsed.userInvocable !== false,
        });
      } catch {
        // Directory does not contain a readable SKILL.md
      }
    }
    return discovered;
  }

  public dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

export class AgyCustomizationProvider implements vscode.ChatSessionCustomizationProvider, vscode.Disposable {
  public readonly registry: AgySkillRegistry;
  public readonly onDidChange: vscode.Event<void>;

  public constructor(backend: AcpBackendInterface, controller: AgySessionController, appDataDir = 'antigravity') {
    this.registry = new AgySkillRegistry(backend, controller, appDataDir);
    this.onDidChange = this.registry.onDidChange;
  }

  public async provideChatSessionCustomizations(
    sessionResource: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionCustomizationItem[]> {
    return await this.registry.provideCustomizations(sessionResource, token);
  }

  public static register(
    backend: AcpBackendInterface,
    controller: AgySessionController,
    appDataDir = 'antigravity',
  ): { provider: AgyCustomizationProvider; disposable: vscode.Disposable } {
    const provider = new AgyCustomizationProvider(backend, controller, appDataDir);
    const registerFn = (vscode.chat as Partial<typeof vscode.chat>).registerChatSessionCustomizationProvider;
    const regDisposable =
      typeof registerFn === 'function'
        ? registerFn(
            ANTIGRAVITY_SCHEME,
            {
              label: 'Antigravity',
              iconId: 'sparkle',
              supportedTypes: [getSkillCustomizationType()],
            },
            provider,
          )
        : new vscode.Disposable(() => {
            /* customization provider API unavailable in host */
          });
    return {
      provider,
      disposable: vscode.Disposable.from(provider, regDisposable),
    };
  }

  public dispose(): void {
    this.registry.dispose();
  }
}
