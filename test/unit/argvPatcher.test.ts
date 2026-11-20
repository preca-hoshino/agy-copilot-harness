import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const EXTENSION_ID = 'antigravity.agy-copilot-harness';

const mocks = vi.hoisted(() => ({
  createChatSessionItemController: vi.fn<() => unknown>(),
  showInformationMessage: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  executeCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  homedirOverride: undefined as string | undefined,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => mocks.homedirOverride ?? actual.homedir();
  return {
    ...actual,
    homedir,
    default: {
      ...actual,
      homedir,
    },
  };
});

vi.mock('vscode', () => ({
  chat: {
    get createChatSessionItemController(): unknown {
      return mocks.createChatSessionItemController;
    },
  },
  window: {
    showInformationMessage: mocks.showInformationMessage,
  },
  commands: {
    executeCommand: mocks.executeCommand,
  },
}));

import {
  checkAndEnsureProposedApi,
  ensureProposedApiInArgvContent,
  isProposedApiAvailable,
} from '../../src/bootstrap/argvPatcher.js';

function createMockOutputChannel(): vscode.OutputChannel & { lines: string[] } {
  const lines: string[] = [];
  return {
    name: 'Test',
    lines,
    append: vi.fn((value: string) => {
      lines.push(value);
    }),
    appendLine: vi.fn((value: string) => {
      lines.push(value);
    }),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('ensureProposedApiInArgvContent', () => {
  it('creates enable-proposed-api array from empty content', () => {
    const result = ensureProposedApiInArgvContent('', EXTENSION_ID);
    expect(result.changed).toBe(true);
    expect(parse(result.content)).toEqual({
      'enable-proposed-api': [EXTENSION_ID],
    });
  });

  it('handles whitespace-only content', () => {
    const result = ensureProposedApiInArgvContent('   \r\n  ', EXTENSION_ID);
    expect(result.changed).toBe(true);
    expect(parse(result.content)).toEqual({
      'enable-proposed-api': [EXTENSION_ID],
    });
  });

  it('preserves all JSONC comments and tab indentation in argv.json', () => {
    const input = [
      '// Top-level header comment',
      '/* Multi-line',
      '   block comment */',
      '{',
      '\t// Hardware acceleration hint',
      '\t"enable-crash-reporter": true,',
      '',
      '\t// Locale comment',
      '\t"locale": "en"',
      '}',
      '',
    ].join('\n');

    const result = ensureProposedApiInArgvContent(input, EXTENSION_ID);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('// Top-level header comment');
    expect(result.content).toContain('/* Multi-line\n   block comment */');
    expect(result.content).toContain('// Hardware acceleration hint');
    expect(result.content).toContain('// Locale comment');
    expect(parse(result.content)).toEqual({
      'enable-crash-reporter': true,
      locale: 'en',
      'enable-proposed-api': [EXTENSION_ID],
    });
  });

  it('appends to existing enable-proposed-api array while keeping array comments', () => {
    const input = [
      '{',
      '  "enable-proposed-api": [',
      '    // Keep existing extension comment',
      '    "other.extension"',
      '  ]',
      '}',
      '',
    ].join('\n');

    const result = ensureProposedApiInArgvContent(input, EXTENSION_ID);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('// Keep existing extension comment');
    expect(parse(result.content)).toEqual({
      'enable-proposed-api': ['other.extension', EXTENSION_ID],
    });
  });

  it('upgrades existing string enable-proposed-api value to array when different', () => {
    const input = '{\n  // Existing single string format\n  "enable-proposed-api": "other.extension"\n}\n';

    const result = ensureProposedApiInArgvContent(input, EXTENSION_ID);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('// Existing single string format');
    expect(parse(result.content)).toEqual({
      'enable-proposed-api': ['other.extension', EXTENSION_ID],
    });
  });

  it('is an idempotent no-op when string value already matches extensionId', () => {
    const input = `{\n  // Already enabled as string\n  "enable-proposed-api": "${EXTENSION_ID}"\n}\n`;

    const result = ensureProposedApiInArgvContent(input, EXTENSION_ID);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  it('is an idempotent no-op on repeated calls', () => {
    const input = '// Keep comment\n{\n  "locale": "zh-cn"\n}\n';
    const first = ensureProposedApiInArgvContent(input, EXTENSION_ID);
    expect(first.changed).toBe(true);

    const second = ensureProposedApiInArgvContent(first.content, EXTENSION_ID);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });
});

describe('isProposedApiAvailable & checkAndEnsureProposedApi', () => {
  let tempHomeDir = '';

  beforeEach(async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-argv-test-'));
    mocks.homedirOverride = tempHomeDir;
    mocks.createChatSessionItemController = vi.fn();
    mocks.showInformationMessage.mockReset();
    mocks.executeCommand.mockReset();
  });

  afterEach(async () => {
    mocks.homedirOverride = undefined;
    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true });
    }
  });

  it('detects when proposed chat API is available vs unavailable', () => {
    expect(isProposedApiAvailable()).toBe(true);

    (mocks as { createChatSessionItemController: unknown }).createChatSessionItemController = undefined;
    expect(isProposedApiAvailable()).toBe(false);
  });

  it('returns true immediately without prompting when proposed API is already active', async () => {
    const channel = createMockOutputChannel();
    const ok = await checkAndEnsureProposedApi(EXTENSION_ID, channel);

    expect(ok).toBe(true);
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('patches missing argv.json, prompts Reload Window, and triggers reload when accepted', async () => {
    (mocks as { createChatSessionItemController: unknown }).createChatSessionItemController = undefined;
    mocks.showInformationMessage.mockResolvedValue('Reload Window');
    mocks.executeCommand.mockResolvedValue(undefined);

    const channel = createMockOutputChannel();
    const ok = await checkAndEnsureProposedApi(EXTENSION_ID, channel);

    expect(ok).toBe(false);
    const writtenArgv = await fs.readFile(path.join(tempHomeDir, '.vscode', 'argv.json'), 'utf8');
    expect(parse(writtenArgv)).toEqual({
      'enable-proposed-api': [EXTENSION_ID],
    });
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Reload VS Code to activate'),
      'Reload Window',
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(channel.lines.some((line) => line.includes('Added'))).toBe(true);
  });

  it('does not reload when user dismisses the prompt', async () => {
    (mocks as { createChatSessionItemController: unknown }).createChatSessionItemController = undefined;
    mocks.showInformationMessage.mockResolvedValue(undefined);

    const argvDir = path.join(tempHomeDir, '.vscode');
    await fs.mkdir(argvDir, { recursive: true });
    await fs.writeFile(
      path.join(argvDir, 'argv.json'),
      `// Keep me\n{\n  "enable-proposed-api": ["${EXTENSION_ID}"]\n}\n`,
      'utf8',
    );

    const channel = createMockOutputChannel();
    const ok = await checkAndEnsureProposedApi(EXTENSION_ID, channel);

    expect(ok).toBe(false);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});
