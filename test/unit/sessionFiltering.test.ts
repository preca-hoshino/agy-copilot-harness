import * as os from 'node:os';
import * as nodePath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockEventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: (): void => {
          this.listeners.delete(listener);
        },
      };
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
    public readonly authority: string;
    public readonly path: string;
    public readonly fsPath: string;
    private readonly serialized: string;

    private constructor(scheme: string, authority: string, uriPath: string, fsPath: string, serialized: string) {
      this.scheme = scheme;
      this.authority = authority;
      this.path = uriPath;
      this.fsPath = fsPath;
      this.serialized = serialized;
    }

    public static file(filePath: string): MockUri {
      const normalized = filePath.replace(/\\/g, '/');
      const uriPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
      return new MockUri('file', '', uriPath, filePath, `file://${encodeURI(uriPath)}`);
    }

    public static from(components: { readonly scheme: string; readonly path?: string; readonly authority?: string }): MockUri {
      const uriPath = components.path ?? '/';
      const authority = components.authority ?? '';
      return new MockUri(components.scheme, authority, uriPath, uriPath, `${components.scheme}:${uriPath}`);
    }

    public toString(): string {
      return this.serialized;
    }
  }

  class MockThemeIcon {
    public readonly id: string;

    public constructor(id: string) {
      this.id = id;
    }
  }

  class MockCancellationError extends Error {
    public constructor() {
      super('Canceled');
      this.name = 'Canceled';
    }
  }

  class MockCancellationTokenSource {
    private readonly emitter = new MockEventEmitter<void>();
    private cancelled = false;

    public readonly token: vscode.CancellationToken = {
      get isCancellationRequested(): boolean {
        return false;
      },
      onCancellationRequested: this.emitter.event as unknown as vscode.CancellationToken['onCancellationRequested'],
    };

    public constructor() {
      const self = this;
      this.token = {
        get isCancellationRequested(): boolean {
          return self.cancelled;
        },
        onCancellationRequested: this.emitter.event as unknown as vscode.CancellationToken['onCancellationRequested'],
      };
    }

    public cancel(): void {
      if (!this.cancelled) {
        this.cancelled = true;
        this.emitter.fire();
      }
    }

    public dispose(): void {
      this.emitter.dispose();
    }
  }

  const state = {
    workspaceFolders: undefined as vscode.WorkspaceFolder[] | undefined,
    isAgentSessionsWorkspace: false,
    inputStateGroupWrites: 0,
  };

  const ChatSessionStatus = {
    Failed: 0,
    Completed: 1,
    InProgress: 2,
    NeedsInput: 3,
  } as const;

  const createController = (
    id: string,
    _refreshHandler: (token: vscode.CancellationToken) => Thenable<void> | void,
  ): vscode.ChatSessionItemController => {
    const itemMap = new Map<string, vscode.ChatSessionItem>();
    const onDidChangeEmitter = new MockEventEmitter<vscode.ChatSessionItem>();

    const items: vscode.ChatSessionItemCollection = {
      get size(): number {
        return itemMap.size;
      },
      replace(newItems: readonly vscode.ChatSessionItem[]): void {
        itemMap.clear();
        for (const item of newItems) {
          itemMap.set(item.resource.toString(), item);
        }
      },
      add(item: vscode.ChatSessionItem): void {
        itemMap.set(item.resource.toString(), item);
      },
      delete(resource: vscode.Uri): void {
        itemMap.delete(resource.toString());
      },
      get(resource: vscode.Uri): vscode.ChatSessionItem | undefined {
        return itemMap.get(resource.toString());
      },
      forEach(cb: (value: vscode.ChatSessionItem, resource: vscode.Uri) => void): void {
        for (const item of itemMap.values()) {
          cb(item, item.resource);
        }
      },
      [Symbol.iterator](): Iterator<[vscode.Uri, vscode.ChatSessionItem]> {
        return Array.from(itemMap.values())
          .map((item): [vscode.Uri, vscode.ChatSessionItem] => [item.resource, item])
          [Symbol.iterator]();
      },
    };

    return {
      id,
      items,
      onDidChangeChatSessionItemState: onDidChangeEmitter.event as vscode.Event<vscode.ChatSessionItem>,
      createChatSessionItem(resource: vscode.Uri, label: string): vscode.ChatSessionItem {
        return { resource, label };
      },
      createChatSessionInputState(initialGroups: vscode.ChatSessionProviderOptionGroup[]): vscode.ChatSessionInputState {
        let currentGroups = initialGroups;
        const changeEmitter = new MockEventEmitter<void>();
        const disposeEmitter = new MockEventEmitter<void>();

        return {
          get groups(): vscode.ChatSessionProviderOptionGroup[] {
            return currentGroups;
          },
          set groups(next: vscode.ChatSessionProviderOptionGroup[]) {
            state.inputStateGroupWrites += 1;
            currentGroups = next;
            changeEmitter.fire();
          },
          onDidChange: changeEmitter.event as vscode.Event<void>,
          onDidDispose: disposeEmitter.event as vscode.Event<void>,
        };
      },
      dispose(): void {
        onDidChangeEmitter.dispose();
        itemMap.clear();
      },
    };
  };

  return {
    EventEmitter: MockEventEmitter,
    Uri: MockUri,
    ThemeIcon: MockThemeIcon,
    CancellationError: MockCancellationError,
    CancellationTokenSource: MockCancellationTokenSource,
    ChatSessionStatus,
    CancellationToken: { None: { isCancellationRequested: false } },
    chat: {
      createChatSessionItemController: createController,
    },
    workspace: {
      get workspaceFolders(): vscode.WorkspaceFolder[] | undefined {
        return state.workspaceFolders;
      },
      set workspaceFolders(value: vscode.WorkspaceFolder[] | undefined) {
        state.workspaceFolders = value;
      },
      get isAgentSessionsWorkspace(): boolean {
        return state.isAgentSessionsWorkspace;
      },
      set isAgentSessionsWorkspace(value: boolean) {
        state.isAgentSessionsWorkspace = value;
      },
      get __inputStateGroupWrites(): number {
        return state.inputStateGroupWrites;
      },
      set __inputStateGroupWrites(value: number) {
        state.inputStateGroupWrites = value;
      },
      onDidChangeWorkspaceFolders: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      getConfiguration: () => ({
        get: <T>(key: string): T | undefined => {
          if (key === 'defaultMode') {
            return 'default' as T;
          }
          if (key === 'appDataDir') {
            return 'antigravity' as T;
          }
          return undefined;
        },
      }),
    },
  };
});

import * as vscode from 'vscode';
import type { AcpSessionSummary, AcpSessionUpdate } from '../../src/acp/acpTypes.js';
import { AgySessionContentProvider } from '../../src/sessions/agySessionContentProvider.js';
import {
  AgySessionController,
  buildSessionResource,
  getAntigravityScratchDir,
} from '../../src/sessions/agySessionController.js';
import type { BrowserSubagentRenderer } from '../../src/sessions/browserSubagentRenderer.js';
import type { AcpBackendInterface } from '../../src/shared/contracts.js';

interface TestMockWorkspace extends Record<string, unknown> {
  workspaceFolders: vscode.WorkspaceFolder[] | undefined;
  isAgentSessionsWorkspace: boolean;
  __inputStateGroupWrites: number;
}

function getMockWorkspace(): TestMockWorkspace {
  return vscode.workspace as unknown as TestMockWorkspace;
}

function createFakeOutputChannel(): vscode.OutputChannel {
  return {
    name: 'Test',
    append(): void {},
    appendLine(): void {},
    replace(): void {},
    clear(): void {},
    show(): void {},
    hide(): void {},
    dispose(): void {},
  };
}

function createFakeBackend(sessions: AcpSessionSummary[]): {
  backend: AcpBackendInterface;
  setConfigOptionCalls: Array<{ sessionId: string; configId: string; value: string }>;
  disposeBackend: () => void;
} {
  const updateEmitter = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
  const stateEmitter = new vscode.EventEmitter<{ ready: boolean; error?: string | undefined }>();
  const setConfigOptionCalls: Array<{ sessionId: string; configId: string; value: string }> = [];

  const backend: AcpBackendInterface = {
    isReady: true,
    internalHttpPort: undefined,
    csrfToken: 'test-csrf',
    onDidChangeUpdate: updateEmitter.event,
    onDidChangeBackendState: stateEmitter.event,
    ensureStarted: async () => {},
    restart: async () => {},
    logout: async () => {},
    listSessions: async () => ({ sessions }),
    loadSession: async (sessionId: string) => ({
      sessionId,
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
    }),
    resumeSession: async (sessionId: string) => ({ sessionId }),
    newSession: async () => ({ sessionId: 'new-real-session' }),
    setConfigOption: async (sessionId: string, configId: string, value: string) => {
      setConfigOptionCalls.push({ sessionId, configId, value });
      return undefined;
    },
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => {},
    getLastKnownConfigOptions: () => [],
  };

  return {
    backend,
    setConfigOptionCalls,
    disposeBackend: (): void => {
      updateEmitter.dispose();
      stateEmitter.dispose();
    },
  };
}

function makeWorkspaceFolder(folderPath: string, name: string): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.file(folderPath),
    name,
    index: 0,
  };
}

describe('AgySessionController inputState & workspace filtering', () => {
  beforeEach(() => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = undefined;
    ws.isAgentSessionsWorkspace = false;
    ws.__inputStateGroupWrites = 0;
  });

  it('does not throw when previousInputState is undefined in getChatSessionInputState', () => {
    const { backend, disposeBackend } = createFakeBackend([]);
    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));

    const handler = controller.controller.getChatSessionInputState;
    expect(handler).toBeDefined();

    const cancellationToken = { isCancellationRequested: false } as vscode.CancellationToken;
    const state1 = handler?.(undefined, { previousInputState: undefined }, cancellationToken) as vscode.ChatSessionInputState;
    const state2 = handler?.(buildSessionResource('sess-1'), undefined, cancellationToken) as vscode.ChatSessionInputState;

    expect(state1.groups.map((g) => g.id)).toEqual(['mode']);
    expect(state2.groups.map((g) => g.id)).toEqual(['mode']);

    controller.dispose();
    disposeBackend();
  });

  it('shows only the modes advertised by ACP once available', () => {
    const { backend, disposeBackend } = createFakeBackend([]);
    backend.getLastKnownConfigOptions = () => [{
      id: 'mode',
      name: 'Operating mode',
      type: 'select',
      currentValue: 'plan',
      options: [{ value: 'plan', name: 'Plan', description: 'Plan without executing' }],
    }];
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const state = controller.controller.getChatSessionInputState?.(undefined, undefined, token) as vscode.ChatSessionInputState;
    const group = state.groups.find((entry) => entry.id === 'mode');
    expect(group?.items.map((item) => item.id)).toEqual(['plan']);
    expect(group?.selected?.description).toBe('Plan without executing');
    expect(group?.kind).toBeUndefined();
    controller.dispose();
    disposeBackend();
  });

  it('matches exact workspace roots and only lists empty cwd in both kinds of empty window', async () => {
    const projectA = process.platform === 'win32' ? 'D:\\Code Library\\agy-copilot-harness' : '/work/agy-copilot-harness';
    const projectASub = process.platform === 'win32' ? 'D:\\Code Library\\agy-copilot-harness\\src' : '/work/agy-copilot-harness/src';
    const projectB = process.platform === 'win32' ? '/d%3A/Code%20Library/Linguist-New' : '/work/Linguist-New';
    const scratchDir = getAntigravityScratchDir();

    const summaries: AcpSessionSummary[] = [
      { sessionId: 's-proj-a', cwd: projectA, title: 'Harness Task', updatedAt: '2026-11-19T12:00:00Z' },
      { sessionId: 's-proj-a-sub', cwd: projectASub, title: 'Harness Src Task', updatedAt: '2026-11-19T11:00:00Z' },
      { sessionId: 's-proj-b', cwd: projectB, title: 'Linguist Task', updatedAt: '2026-11-19T10:00:00Z' },
      { sessionId: 's-scratch', cwd: scratchDir, title: 'Scratch Task', updatedAt: '2026-11-19T09:00:00Z' },
      { sessionId: 's-empty', cwd: '', title: 'Empty Cwd Task', updatedAt: '2026-11-19T08:00:00Z' },
    ];

    const { backend, disposeBackend } = createFakeBackend(summaries);
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const ws = getMockWorkspace();

    const collectIds = (): string[] => {
      const ids: string[] = [];
      controller.controller.items.forEach((item) => {
        ids.push(item.resource.path.replace(/^\/+/, ''));
      });
      return ids;
    };

    // Case 1: Workspace window open at projectA -> strict cwd match only (excludes subdirectory sessions)
    ws.workspaceFolders = [makeWorkspaceFolder(projectA, 'agy-copilot-harness')];
    ws.isAgentSessionsWorkspace = false;
    await controller.refreshSessions();
    expect(collectIds()).toEqual(['s-proj-a']);
    await expect(controller.getSessionCwd('s-proj-a-sub')).rejects.toThrow('does not belong');

    // Case 1b: Workspace window open at subdirectory -> matches subdirectory session only
    ws.workspaceFolders = [makeWorkspaceFolder(projectASub, 'src')];
    ws.isAgentSessionsWorkspace = false;
    await controller.refreshSessions();
    expect(collectIds()).toEqual(['s-proj-a-sub']);

    // A concrete scratch directory is not a No Project session.
    ws.workspaceFolders = undefined;
    ws.isAgentSessionsWorkspace = false;
    await controller.refreshSessions();
    expect(collectIds()).toEqual(['s-empty']);
    await expect(controller.getSessionCwd('s-empty')).resolves.toBe('');
    await expect(controller.getSessionCwd('untitled-empty')).resolves.toBe('');

    // An empty Agents window uses the same rule.
    ws.workspaceFolders = undefined;
    ws.isAgentSessionsWorkspace = true;
    await controller.refreshSessions();
    expect(collectIds()).toEqual(['s-empty']);

    ws.workspaceFolders = [makeWorkspaceFolder(projectA, 'project'), makeWorkspaceFolder(scratchDir, 'scratch')];
    await controller.refreshSessions();
    expect(collectIds()).toEqual(['s-proj-a', 's-scratch']);
    await expect(controller.getSessionCwd('untitled-empty')).rejects.toThrow('does not belong');

    const output = createFakeOutputChannel();
    const contentProvider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, output);
    const token = new vscode.CancellationTokenSource();
    const resource = buildSessionResource('untitled-workspace');
    await contentProvider.provideHandleOptionsChange(resource, [{ optionId: 'folder', value: projectASub }], token.token);
    await expect(controller.getSessionCwd('untitled-workspace')).resolves.toBe(projectA);
    contentProvider.dispose();
    token.dispose();

    controller.dispose();
    disposeBackend();
  });

  it('skips redundant setConfigOption and inputState mutations when mode is unchanged', async () => {
    const projectA = process.platform === 'win32' ? 'D:\\Code Library\\agy-copilot-harness' : '/work/agy-copilot-harness';
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder(projectA, 'agy-copilot-harness')];

    const { backend, setConfigOptionCalls, disposeBackend } = createFakeBackend([
      { sessionId: 'real-sess', cwd: projectA, title: 'Test', updatedAt: '2026-11-19T12:00:00Z' },
    ]);
    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const fakeBrowserRenderer = {} as BrowserSubagentRenderer;
    const contentProvider = new AgySessionContentProvider(backend, controller, fakeBrowserRenderer, output);

    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const resource = buildSessionResource('real-sess');
    const inputState = controller.controller.getChatSessionInputState?.(
      resource,
      { previousInputState: undefined },
      token,
    ) as vscode.ChatSessionInputState;

    await contentProvider.provideChatSessionContent(resource, token, { inputState });
    expect(ws.__inputStateGroupWrites).toBe(0);

    // Same mode ('default') coming back via MainThread option echo must NOT call backend or mutate inputState.groups
    await contentProvider.provideHandleOptionsChange(resource, [{ optionId: 'mode', value: 'default' }], token);
    expect(setConfigOptionCalls).toHaveLength(0);
    expect(ws.__inputStateGroupWrites).toBe(0);

    // Changing mode ('auto') calls backend once without mutating inputState.groups back
    await contentProvider.provideHandleOptionsChange(resource, [{ optionId: 'mode', value: 'auto' }], token);
    expect(setConfigOptionCalls).toEqual([{ sessionId: 'real-sess', configId: 'mode', value: 'auto' }]);
    expect(ws.__inputStateGroupWrites).toBe(0);

    contentProvider.dispose();
    controller.dispose();
    disposeBackend();
  });

  it('rejects provideChatSessionContent immediately with CancellationError when token cancels mid-load', async () => {
    const projectA = process.platform === 'win32' ? 'D:\\Code Library\\agy-copilot-harness' : '/work/agy-copilot-harness';
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder(projectA, 'agy-copilot-harness')];

    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'slow-sess', cwd: projectA, title: 'Slow Session', updatedAt: '2026-11-19T12:00:00Z' },
    ]);
    let resolvePendingLoad: (() => void) | undefined;
    backend.loadSession = async () =>
      await new Promise((resolve) => {
        resolvePendingLoad = () => {
          resolve({ sessionId: 'slow-sess' });
        };
      });

    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const contentProvider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, output);

    const cts = new vscode.CancellationTokenSource();
    await controller.refreshSessions();
    const resource = buildSessionResource('slow-sess');
    const pendingContent = contentProvider.provideChatSessionContent(resource, cts.token, {
      inputState: undefined,
    } as unknown as vscode.ChatSessionContentContext);

    await vi.waitFor(() => expect(resolvePendingLoad).toBeTypeOf('function'));
    cts.cancel();

    await expect(pendingContent).rejects.toThrow(/Canceled/);

    resolvePendingLoad?.();
    cts.dispose();
    contentProvider.dispose();
    controller.dispose();
    disposeBackend();
  });

  it('skips redundant controller.items.replace when background watcher refreshes identical sessions', async () => {
    const projectA = process.platform === 'win32' ? 'D:\\Code Library\\agy-copilot-harness' : '/work/agy-copilot-harness';
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder(projectA, 'agy-copilot-harness')];

    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 's-proj-a', cwd: projectA, title: 'Harness Task', updatedAt: '2026-11-19T12:00:00Z' },
    ]);
    const controller = new AgySessionController(
      backend,
      createFakeOutputChannel(),
      nodePath.join(os.tmpdir(), 'nonexistent-convs'),
    );

    let replaceCalls = 0;
    const originalReplace = controller.controller.items.replace.bind(controller.controller.items);
    controller.controller.items.replace = (newItems: readonly vscode.ChatSessionItem[]): void => {
      replaceCalls += 1;
      originalReplace(newItems);
    };

    await controller.refreshSessions(undefined, true);
    expect(replaceCalls).toBe(1);

    await controller.refreshSessions(undefined, true);
    expect(replaceCalls).toBe(1);

    await controller.refreshSessions(undefined, false);
    expect(replaceCalls).toBe(2);

    controller.dispose();
    disposeBackend();
  });
});
