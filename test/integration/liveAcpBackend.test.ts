import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AcpSessionSummary, AcpSessionUpdate } from '../../src/acp/acpTypes.js';

vi.mock('vscode', () => {
  class MockEventEmitter<T> {
    private readonly listeners = new Set<(e: T) => void>();

    public readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: (): void => {
          this.listeners.delete(listener);
        },
      };
    };

    public fire(data: T): void {
      for (const listener of this.listeners) {
        listener(data);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter: MockEventEmitter,
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        path: fsPath,
        scheme: 'file',
        toString: (): string => `file://${fsPath}`,
      }),
    },
    workspace: {
      textDocuments: [],
      workspaceFolders: [],
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue?: T): T | undefined => {
          const defaults: Record<string, unknown> = {
            cliPath: '',
            appDataDir: 'antigravity',
            defaultMode: 'default',
            mirrorTerminals: false,
          };
          return (key in defaults ? defaults[key] : defaultValue) as T | undefined;
        },
      }),
      fs: {
        readFile: async (uri: { fsPath: string }): Promise<Uint8Array> => {
          return await fsPromises.readFile(uri.fsPath);
        },
        writeFile: async (uri: { fsPath: string }, content: Uint8Array): Promise<void> => {
          await fsPromises.writeFile(uri.fsPath, content);
        },
        createDirectory: async (uri: { fsPath: string }): Promise<void> => {
          await fsPromises.mkdir(uri.fsPath, { recursive: true });
        },
      },
    },
    window: {
      showQuickPick: vi.fn(async () => undefined),
      createTerminal: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
});

import { AgyBackendManager } from '../../src/acp/agyBackendManager.js';

const AGY_EXE_PATH = 'C:\\Users\\preca\\.gemini\\bin\\agy.exe';
const HAS_AGY_BINARY = fs.existsSync(AGY_EXE_PATH);

function normalizeSessionCwd(rawCwd: string): string {
  const decoded = decodeURIComponent(rawCwd);
  const winDriveMatch = /^\/([a-zA-Z]):\/(.*)$/.exec(decoded);
  if (winDriveMatch?.[1] !== undefined && winDriveMatch[2] !== undefined) {
    return `${winDriveMatch[1].toUpperCase()}:\\${winDriveMatch[2].replace(/\//g, '\\')}`;
  }
  return decoded;
}

async function waitForHttpPort(backend: AgyBackendManager, timeoutMs = 10_000): Promise<number> {
  const start = Date.now();
  while (backend.internalHttpPort === undefined) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for internalHttpPort to be parsed from agy ACP log');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return backend.internalHttpPort;
}

interface GetUserStatusResponse {
  userStatus?: {
    email?: string;
    name?: string;
    userTier?: {
      id?: string;
      name?: string;
    };
    cascadeModelConfigData?: {
      clientModelConfigs?: Array<{
        label?: string;
        modelOrAlias?: { model?: string };
        quotaInfo?: {
          remainingFraction?: number;
          resetTime?: string;
        };
      }>;
    };
  };
}

describe.skipIf(!HAS_AGY_BINARY)('Live Antigravity ACP Backend Integration', () => {
  let tempStorageDir = '';
  let backend: AgyBackendManager | undefined;
  let sessions: AcpSessionSummary[] = [];
  const logLines: string[] = [];

  beforeAll(() => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-copilot-harness-it-'));
    const outputChannel = {
      name: 'Antigravity Test',
      append: (val: string): void => {
        logLines.push(val);
      },
      appendLine: (val: string): void => {
        logLines.push(val);
      },
      replace: (): void => {},
      clear: (): void => {},
      show: (): void => {},
      hide: (): void => {},
      dispose: (): void => {},
    };

    backend = new AgyBackendManager(tempStorageDir, outputChannel);
  });

  afterAll(() => {
    backend?.dispose();
    if (tempStorageDir.length > 0) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  });

  it('starts agy.exe acp, completes initialize, and runs session/list with boot auth retry', async () => {
    expect(backend).toBeDefined();
    if (backend === undefined) {
      return;
    }

    const stateChanges: Array<{ ready: boolean; error?: string | undefined }> = [];
    const sub = backend.onDidChangeBackendState((state) => {
      stateChanges.push(state);
    });

    await backend.ensureStarted();
    expect(backend.isReady).toBe(true);
    expect(stateChanges.some((s) => s.ready)).toBe(true);

    const listResult = await backend.listSessions();
    expect(Array.isArray(listResult.sessions)).toBe(true);
    sessions = listResult.sessions;

    sub.dispose();
  }, 60_000);

  it('extracts internal HTTP port from log and fetches tier and model configs via GetUserStatus', async () => {
    expect(backend).toBeDefined();
    if (backend === undefined) {
      return;
    }

    const httpPort = await waitForHttpPort(backend);
    expect(httpPort).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${httpPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': backend.csrfToken,
        },
        body: JSON.stringify({ metadata: {} }),
      },
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as GetUserStatusResponse;
    expect(payload.userStatus).toBeDefined();
    expect(payload.userStatus?.userTier?.id).toBeTypeOf('string');
    expect((payload.userStatus?.userTier?.id ?? '').length).toBeGreaterThan(0);
    expect(payload.userStatus?.userTier?.name).toBeTypeOf('string');

    const modelConfigs = payload.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
    expect(modelConfigs.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(process.env.AGY_LIVE_EDIT_TEST !== '1')('observes write notifications and fully-idle timing in an isolated session', async () => {
    expect(backend).toBeDefined();
    if (backend === undefined) {
      throw new Error('Backend was not initialized');
    }
    const workspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agy-live-edit-'));
    const file = path.join(workspace, 'probe.txt');
    const events: Array<{ event: string; elapsed: number; exists: boolean }> = [];
    const start = Date.now();
    const created = await backend.newSession(workspace);
    const sessionId = created.sessionId;
    const record = (event: string): void => {
      events.push({ event, elapsed: Date.now() - start, exists: fs.existsSync(file) });
    };
    const subscription = backend.onDidChangeUpdate((entry) => {
      if (entry.sessionId !== sessionId) {
        return;
      }
      const update = entry.update;
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        record(`${update.name ?? 'update'}:${update.status ?? 'unknown'}`);
      } else if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        const text = typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string'
          ? content.text.slice(0, 200)
          : '';
        record(`agent_message_chunk:${text}`);
      }
    });
    const cancellation: import('vscode').CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    try {
      await backend.setConfigOption(sessionId, 'mode', 'auto');
      record('prompt_start');
      const result = await backend.prompt(sessionId, [{ type: 'text', text:
        `Use the write_file tool to create ${file} with exactly the text "agy integration probe". Do not use a terminal. Then reply done.`,
      }], cancellation);
      record(`prompt_response:${result.stopReason ?? 'unknown'}`);
      await backend.waitForConversationFullyIdle(sessionId, cancellation);
      record('fully_idle');
      console.log('[isolated edit probe]', JSON.stringify(events));
      expect(fs.existsSync(file)).toBe(true);
      expect(await fsPromises.readFile(file, 'utf8')).toContain('agy integration probe');
    } finally {
      subscription.dispose();
      await fsPromises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 180_000);

  it('loads an existing session via session/load and emits replay session/update events', async () => {
    expect(backend).toBeDefined();
    if (backend === undefined || sessions.length === 0) {
      return;
    }

    const targetSession = sessions.find((s) => s.title === 'Chinese Greeting') ?? sessions[sessions.length - 1];
    expect(targetSession).toBeDefined();
    if (targetSession === undefined) {
      return;
    }

    const receivedUpdates: Array<{ sessionId: string; update: AcpSessionUpdate }> = [];
    const sub = backend.onDidChangeUpdate((evt) => {
      if (evt.sessionId === targetSession.sessionId) {
        receivedUpdates.push(evt);
      }
    });

    const loadResult = await backend.loadSession(targetSession.sessionId, normalizeSessionCwd(targetSession.cwd));
    sub.dispose();

    expect(loadResult.sessionId).toBe(targetSession.sessionId);
    expect(loadResult.configOptions?.length ?? 0).toBeGreaterThan(0);
    expect(loadResult.models?.availableModels.length ?? 0).toBeGreaterThan(0);
    expect(loadResult.modes?.availableModes.length ?? 0).toBeGreaterThan(0);
    expect(backend.getLastKnownConfigOptions().length).toBeGreaterThan(0);
    expect(receivedUpdates.length).toBeGreaterThan(0);
  }, 45_000);
});
