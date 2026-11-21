import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const files = await import('node:fs/promises');
  class Uri {
    public constructor(public readonly fsPath: string) {}
    public static file(value: string): Uri { return new Uri(value); }
    public toString(): string { return `file://${this.fsPath}`; }
  }
  class Disposable {
    public constructor(private readonly callback: () => void) {}
    public dispose(): void { this.callback(); }
  }
  return {
    Uri,
    Disposable,
    workspace: {
      textDocuments: [],
      fs: {
        createDirectory: async (uri: Uri) => { await files.mkdir(uri.fsPath, { recursive: true }); },
        writeFile: async (uri: Uri, content: Uint8Array) => { await files.writeFile(uri.fsPath, content); },
      },
    },
  };
});

import * as vscode from 'vscode';
import { ClientCapabilitiesHandler } from '../../src/acp/clientCapabilitiesHandler.js';

const temporaryDirectories: string[] = [];

async function temporaryFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-client-write-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'nested', 'test.txt');
}

function createHandler(): ClientCapabilitiesHandler {
  return new ClientCapabilitiesHandler({
    name: 'test', append: vi.fn(), appendLine: vi.fn(), replace: vi.fn(), clear: vi.fn(),
    show: vi.fn(), hide: vi.fn(), dispose: vi.fn(),
  });
}

describe('ACP client file writes', () => {
  afterEach(async () => {
    (vscode.workspace.textDocuments as vscode.TextDocument[]).length = 0;
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('wraps the actual write in the registered session handler', async () => {
    const filename = await temporaryFile();
    const handler = createHandler();
    const events: string[] = [];
    const registration = handler.registerFileWriteHandler('session-1', async (uri, write) => {
      expect(uri.fsPath).toBe(filename);
      await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
      events.push('before');
      await write();
      events.push(await fs.readFile(filename, 'utf8'));
    });
    try {
      await handler.handleRequest('fs/write_text_file', { sessionId: 'session-1', path: filename, content: 'written' });
      expect(events).toEqual(['before', 'written']);
    } finally {
      registration.dispose();
      handler.dispose();
    }
  });

  it('falls back to direct writes for other sessions and after unregistration', async () => {
    const filename = await temporaryFile();
    const handler = createHandler();
    const wrapper = vi.fn(async (_uri: vscode.Uri, write: () => Promise<void>) => { await write(); });
    const registration = handler.registerFileWriteHandler('session-1', wrapper);
    try {
      await handler.handleRequest('fs/write_text_file', { sessionId: 'session-2', path: filename, content: 'other' });
      registration.dispose();
      await handler.handleRequest('fs/write_text_file', { sessionId: 'session-1', path: filename, content: 'after' });
      expect(wrapper).not.toHaveBeenCalled();
      expect(await fs.readFile(filename, 'utf8')).toBe('after');
    } finally {
      handler.dispose();
    }
  });

  it('rejects a write to a dirty open document without modifying the file', async () => {
    const filename = await temporaryFile();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, 'saved');
    const handler = createHandler();
    (vscode.workspace.textDocuments as vscode.TextDocument[]).push({ uri: vscode.Uri.file(filename), isDirty: true } as vscode.TextDocument);
    try {
      await expect(handler.handleRequest('fs/write_text_file', {
        sessionId: 'session-1', path: filename, content: 'new',
      })).rejects.toThrow('unsaved changes');
      expect(await fs.readFile(filename, 'utf8')).toBe('saved');
    } finally {
      handler.dispose();
    }
  });
});