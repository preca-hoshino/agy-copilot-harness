import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockEventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
    public fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    public dispose(): void {
      this.listeners.clear();
    }
  }

  class MockUri {
    public readonly scheme: string;
    public readonly path: string;
    public readonly fsPath: string;
    private readonly serialized: string;

    private constructor(scheme: string, uriPath: string, fsPath: string, serialized: string) {
      this.scheme = scheme;
      this.path = uriPath;
      this.fsPath = fsPath;
      this.serialized = serialized;
    }

    public static file(fsPath: string): MockUri {
      const normalized = fsPath.replace(/\\/g, '/');
      const uriPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
      return new MockUri('file', uriPath, fsPath, `file://${uriPath}`);
    }

    public static parse(raw: string): MockUri {
      return new MockUri('file', raw, raw, raw);
    }

    public static from(components: { scheme: string; path: string }): MockUri {
      return new MockUri(components.scheme, components.path, components.path, `${components.scheme}:${components.path}`);
    }

    public toString(): string {
      return this.serialized;
    }
  }

  class MockChatSessionCustomizationType {
    public static readonly Skill = new MockChatSessionCustomizationType('skill');
    public constructor(public readonly id: string) {}
  }

  return {
    EventEmitter: MockEventEmitter,
    Uri: MockUri,
    ChatSessionCustomizationType: MockChatSessionCustomizationType,
    Disposable: class {
      public constructor(private readonly fn: () => void) {}
      public dispose(): void {
        this.fn();
      }
      public static from(...items: Array<{ dispose: () => void }>): { dispose: () => void } {
        return { dispose: () => items.forEach((item) => item.dispose()) };
      }
    },
    workspace: {
      workspaceFolders: [],
    },
  };
});

import type * as vscode from 'vscode';
import {
  AgyCustomizationProvider,
  formatSkillReadMarkdownLink,
  isSkillMarkdownPath,
  parseSkillFrontmatter,
  resolveSkillDisplayNameSync,
} from '../../src/sessions/agyCustomizationProvider.js';
import type { AgySessionController } from '../../src/sessions/agySessionController.js';
import type { AcpBackendInterface } from '../../src/shared/contracts.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'agy-custom-provider-'));
  tempDirs.push(dir);
  return dir;
}

describe('agyCustomizationProvider', () => {
  it('parses YAML frontmatter including user-invocable flag and quotes', () => {
    const parsed = parseSkillFrontmatter(
      '---\nname: "my-custom-skill"\ndescription: \'Runs build pipeline\'\nuser-invocable: false\n---\n# Body\n',
    );
    expect(parsed).toEqual({
      name: 'my-custom-skill',
      description: 'Runs build pipeline',
      userInvocable: false,
    });
  });

  it('detects SKILL.md paths and resolves frontmatter name with directory fallback', async () => {
    const root = await makeTempDir();
    const skillDir = nodePath.join(root, 'alpha_skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = nodePath.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillFile, '---\nname: alpha-display\n---\ncontent', 'utf8');

    expect(isSkillMarkdownPath(skillFile)).toBe(true);
    expect(isSkillMarkdownPath(nodePath.join(skillDir, 'README.md'))).toBe(false);
    expect(resolveSkillDisplayNameSync(skillFile)).toBe('alpha-display');

    const fallbackFile = nodePath.join(root, 'fallback-dir', 'SKILL.md');
    expect(resolveSkillDisplayNameSync(fallbackFile)).toBe('fallback-dir');

    const formatted = formatSkillReadMarkdownLink(skillFile, 'alpha-display', 5, 20);
    expect(formatted).toContain('?vscodeLinkType=skill#5-5), lines 5 to 20');
  });

  it('discovers workspace skills, excludes user-invocable: false, and merges LS commands', async () => {
    const root = await makeTempDir();
    const repoDir = nodePath.join(root, 'repo');
    const customAppData = nodePath.join(root, 'appdata');
    await fs.mkdir(nodePath.join(repoDir, '.agents', 'skills', 'deploy-app'), { recursive: true });
    await fs.mkdir(nodePath.join(repoDir, '.agents', 'skills', 'hidden-helper'), { recursive: true });
    await fs.mkdir(nodePath.join(customAppData, 'skills', 'global-skill'), { recursive: true });

    await fs.writeFile(
      nodePath.join(repoDir, '.agents', 'skills', 'deploy-app', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy service\n---\n',
      'utf8',
    );
    await fs.writeFile(
      nodePath.join(repoDir, '.agents', 'skills', 'hidden-helper', 'SKILL.md'),
      '---\nname: internal-only\nuser-invocable: false\n---\n',
      'utf8',
    );
    await fs.writeFile(
      nodePath.join(customAppData, 'skills', 'global-skill', 'SKILL.md'),
      '---\nname: deploy\ndescription: Shadowed global\n---\n',
      'utf8',
    );

    const backend = {
      isReady: true,
      internalHttpPort: undefined,
      csrfToken: '',
      onDidChangeUpdate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeBackendState: vi.fn(() => ({ dispose: vi.fn() })),
      ensureStarted: vi.fn(async () => {}),
      listSessions: vi.fn(async () => ({ sessions: [] })),
      loadSession: vi.fn(async () => ({ sessionId: 's1' })),
      resumeSession: vi.fn(async () => ({ sessionId: 's1' })),
      newSession: vi.fn(async () => ({ sessionId: 's1' })),
      setConfigOption: vi.fn(async () => undefined),
      prompt: vi.fn(async () => ({})),
      waitForConversationFullyIdle: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      getLastKnownConfigOptions: vi.fn(() => []),
      getAvailableCommands: vi.fn(() => [
        { name: 'review', description: 'Review diff', source: 'acp' as const },
        { name: 'plan', description: 'Plan command', source: 'acp' as const },
        { name: 'compact', description: 'Compact context', source: 'acp' as const },
      ]),
      fetchSlashCommands: vi.fn(async () => [{ name: 'test-all', description: 'Run tests', source: 'ls' as const }]),
    } as unknown as AcpBackendInterface;

    const controller = {
      resolveSessionId: (id: string) => id,
      isNewSession: () => false,
      getSessionCwd: async () => repoDir,
    } as unknown as AgySessionController;

    const provider = new AgyCustomizationProvider(backend, controller, customAppData);
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const sessionUri = { scheme: 'antigravity', path: '/s1', fsPath: '/s1', toString: () => 'antigravity:/s1' } as vscode.Uri;

    const items = await provider.provideChatSessionCustomizations(sessionUri, token);
    expect(items.map((item) => item.name)).toEqual(['deploy', 'review', 'test-all']);
    expect(items[0]?.description).toBe('Deploy service');
    expect(items[0]?.source).toBe('workspace');
    provider.dispose();
  });
});
