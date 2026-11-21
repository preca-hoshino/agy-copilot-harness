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

  class MockChatRequestTurn {
    public constructor(public readonly prompt: string) {}
  }

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
    ChatRequestTurn2: MockChatRequestTurn,
    ChatResponseTurn2: class {
      public constructor(public readonly response: unknown[], public readonly result: unknown, public readonly participant: string) {}
    },
    ChatResponseMarkdownPart: class {
      public constructor(public readonly value: unknown) {}
    },
    MarkdownString: class {
      public constructor(public readonly value = '') {}
      public appendCodeblock(): this { return this; }
      public appendText(): this { return this; }
    },
    ChatQuestionType: { SingleSelect: 2 },
    window: { showQuickPick: vi.fn() },
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
import type { AcpRequestPermissionParams, AcpSessionPromptResult, AcpSessionSummary, AcpSessionUpdate } from '../../src/acp/acpTypes.js';
import type { AgyLanguageModelProvider } from '../../src/models/agyLanguageModelProvider.js';
import { AgyChatParticipant } from '../../src/sessions/agyChatParticipant.js';
import { AgySessionContentProvider } from '../../src/sessions/agySessionContentProvider.js';
import {
  AgySessionController,
  buildSessionResource,
  getAntigravityScratchDir,
  normalizeAcpCwd,
} from '../../src/sessions/agySessionController.js';
import type { BrowserSubagentRenderer } from '../../src/sessions/browserSubagentRenderer.js';
import type { AcpBackendInterface, PermissionPrompt, QuotaServiceInterface } from '../../src/shared/contracts.js';

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
    waitForConversationFullyIdle: async () => {},
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

describe('normalizeAcpCwd', () => {
  it.each([
    ['/d:/Code%20Library/harness', 'd:\\Code Library\\harness'],
    ['/d%3A/Code%20Library/harness', 'd:\\Code Library\\harness'],
    ['file:///d:/Code%20Library/harness', 'd:\\Code Library\\harness'],
    ['/d:/Code%2520Library/harness', 'd:\\Code%20Library\\harness'],
    ['d:\\Code%20Library\\harness', 'd:\\Code%20Library\\harness'],
  ])('normalizes %s to %s', (cwd, expected) => {
    expect(normalizeAcpCwd(cwd)).toBe(expected);
  });
});

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

  it('keeps a realized session in its project after ACP lists an encoded cwd', async () => {
    const project = 'd:\\Code Library\\harness';
    getMockWorkspace().workspaceFolders = [makeWorkspaceFolder(project, 'harness')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'real-sess', cwd: '/d:/Code%20Library/harness', title: 'Test' },
    ]);
    const loadSession = vi.spyOn(backend, 'loadSession');
    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const provider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, output);
    const cts = new vscode.CancellationTokenSource();
    const resource = buildSessionResource('real-sess');
    const untitledId = 'untitled-project';

    try {
      await expect(controller.getSessionCwd(untitledId)).resolves.toBe(project);
      controller.markSessionRealized(untitledId, 'real-sess');
      await controller.refreshSessions(undefined, true);

      expect(controller.controller.items.get(resource)).toBeDefined();
      await expect(controller.getSessionCwd(untitledId)).resolves.toBe(project);
      const inputState = controller.controller.createChatSessionInputState([]);
      await provider.provideChatSessionContent(resource, cts.token, { inputState });
      expect(loadSession).toHaveBeenCalledWith('real-sess', project, cts.token);
    } finally {
      cts.dispose();
      provider.dispose();
      controller.dispose();
      disposeBackend();
    }
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

  it.each([
    { action: 'finishing normally', stopAfterReopening: false },
    { action: 'pressing Stop', stopAfterReopening: true },
  ])('reattaches without reloading ACP history before $action', async ({ stopAfterReopening }) => {
    const { backend, disposeBackend } = createFakeBackend([{ sessionId: 'running', cwd: '', title: 'Running session' }]);
    const finish = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt').mockReturnValue(finish.promise);
    const load = vi.spyOn(backend, 'loadSession');
    const cancel = vi.spyOn(backend, 'cancel');
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const browser = { disposeSession: vi.fn() } as unknown as BrowserSubagentRenderer;
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      browser, output,
    );
    const provider = new AgySessionContentProvider(
      backend, controller, browser, output, undefined, (id) => participant.getActiveSession(id),
    );
    const resource = buildSessionResource('running');
    const draftResource = buildSessionResource('untitled-background');
    const chatSessionItem = { resource, label: 'Running session' };
    controller.markSessionRealized('untitled-background', 'running');
    const source = new vscode.CancellationTokenSource();
    const historyLoad = new vscode.CancellationTokenSource();
    const stop = new vscode.CancellationTokenSource();
    const completedLoad = new vscode.CancellationTokenSource();
    const carousel = Promise.withResolvers<Record<string, unknown> | undefined>();
    const first = { push: vi.fn(), questionCarousel: vi.fn(() => carousel.promise) } as unknown as vscode.ChatResponseStream;
    const reopened = { push: vi.fn() } as unknown as vscode.ChatResponseStream;
    const inputState = controller.controller.createChatSessionInputState([]);
    let ask: PermissionPrompt | undefined;
    backend.registerPermissionPrompt = (_id, handler) => {
      ask = handler;
      return { dispose: () => { ask = undefined; } };
    };

    const running = participant.createHandler()(
      { prompt: 'Keep working', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { ...chatSessionItem, resource: draftResource }, isUntitled: true } }, first, source.token,
    );
    const emit = (text: string): void => {
      updates.fire({ sessionId: 'running', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    };
    const permission: AcpRequestPermissionParams = {
      sessionId: 'running', toolCall: { toolCallId: 'terminal-1', kind: 'execute', rawInput: { command: 'Get-Location' } },
      options: [{ optionId: 'no', kind: 'reject_once', name: 'Reject' }],
    };
    const pick = vi.mocked(vscode.window.showQuickPick);
    pick.mockReset();
    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      emit('before reopening');
      expect(first.push).toHaveBeenCalledTimes(1);
      pick.mockResolvedValueOnce({ label: 'Reject', optionId: 'no' } as vscode.QuickPickItem);
      const pendingPermission = ask?.(permission);
      expect(first.questionCarousel).toHaveBeenCalledOnce();
      expect(pick).not.toHaveBeenCalled();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.NeedsInput);
      const content = await provider.provideChatSessionContent(resource, historyLoad.token, { inputState });
      expect(content.history.at(-1)).toMatchObject({ prompt: 'Keep working' });
      expect(load).not.toHaveBeenCalled();
      const attached = content.activeResponseCallback?.(reopened, stop.token);
      historyLoad.cancel();
      source.cancel();
      emit('after reopening');
      expect(reopened.push).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: { value: 'before reopening' } }));
      expect(reopened.push).toHaveBeenNthCalledWith(2, expect.objectContaining({ value: { value: 'after reopening' } }));
      expect(first.push).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledTimes(1);

      await expect(pendingPermission).resolves.toBe('no');
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.InProgress);
      carousel.resolve(undefined);
      expect(pick).toHaveBeenCalledWith([expect.objectContaining({ detail: 'Get-Location' })], expect.anything(), expect.anything());

      if (stopAfterReopening) {
        stop.cancel();
        expect(cancel).toHaveBeenCalledExactlyOnceWith('running');
      }
      finish.resolve({ stopReason: stopAfterReopening ? 'cancelled' : 'end_turn' });
      await running;
      await attached;
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Completed);
      expect(cancel).toHaveBeenCalledTimes(stopAfterReopening ? 1 : 0);
      await provider.provideChatSessionContent(resource, completedLoad.token, { inputState });
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      carousel.resolve(undefined);
      finish.resolve({ stopReason: 'end_turn' });
      await running;
      source.dispose();
      historyLoad.dispose();
      stop.dispose();
      completedLoad.dispose();
      updates.dispose();
      provider.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
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

  it('drains replay updates after the response and isolates concurrent loads of one session', async () => {
    const { backend, disposeBackend } = createFakeBackend([{ sessionId: 'replay', cwd: '', title: 'Replay' }]);
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    const firstResponse = Promise.withResolvers<{ sessionId: string }>();
    const load = vi.spyOn(backend, 'loadSession').mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce({ sessionId: 'replay' });
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const provider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, createFakeOutputChannel());
    const source = new vscode.CancellationTokenSource();
    const resource = buildSessionResource('replay');
    const context = { inputState: undefined } as unknown as vscode.ChatSessionContentContext;
    const emit = (text: string): void => updates.fire({ sessionId: 'replay', update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text },
    } });
    try {
      const first = provider.provideChatSessionContent(resource, source.token, context);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      const second = provider.provideChatSessionContent(resource, source.token, context);
      firstResponse.resolve({ sessionId: 'replay' });
      await Promise.resolve();
      emit('first tail');
      const firstResult = await first;
      expect(firstResult.history).toMatchObject([{ prompt: 'first tail' }]);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      emit('second tail');
      const secondResult = await second;
      expect(secondResult.history).toMatchObject([{ prompt: 'second tail' }]);
    } finally {
      firstResponse.resolve({ sessionId: 'replay' });
      source.dispose();
      provider.dispose();
      controller.dispose();
      updates.dispose();
      disposeBackend();
    }
  });

  it('does not let a cancelled in-flight replay contaminate a reopened session', async () => {
    const { backend, disposeBackend } = createFakeBackend([{ sessionId: 'cancel-replay', cwd: '', title: 'Replay' }]);
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    const firstResponse = Promise.withResolvers<{ sessionId: string }>();
    const load = vi.spyOn(backend, 'loadSession').mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce({ sessionId: 'cancel-replay' });
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const provider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, createFakeOutputChannel());
    const firstToken = new vscode.CancellationTokenSource();
    const secondToken = new vscode.CancellationTokenSource();
    const resource = buildSessionResource('cancel-replay');
    const context = { inputState: undefined } as unknown as vscode.ChatSessionContentContext;
    const emit = (text: string): void => updates.fire({ sessionId: 'cancel-replay', update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text },
    } });
    try {
      const first = provider.provideChatSessionContent(resource, firstToken.token, context);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      firstToken.cancel();
      await expect(first).rejects.toThrow('Canceled');
      const second = provider.provideChatSessionContent(resource, secondToken.token, context);
      firstResponse.resolve({ sessionId: 'cancel-replay' });
      await Promise.resolve();
      emit('old tail');
      expect(load).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      emit('new replay');
      expect((await second).history).toMatchObject([{ prompt: 'new replay' }]);
    } finally {
      firstResponse.resolve({ sessionId: 'cancel-replay' });
      firstToken.dispose();
      secondToken.dispose();
      provider.dispose();
      controller.dispose();
      updates.dispose();
      disposeBackend();
    }
  });

  it('keeps late updates from a failed load out of the next replay', async () => {
    const sessionId = 'failed-replay';
    const { backend, disposeBackend } = createFakeBackend([{ sessionId, cwd: '', title: 'Replay' }]);
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    const firstResponse = Promise.withResolvers<{ sessionId: string }>();
    const load = vi.spyOn(backend, 'loadSession').mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce({ sessionId });
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const provider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, createFakeOutputChannel());
    const source = new vscode.CancellationTokenSource();
    const resource = buildSessionResource(sessionId);
    const context = { inputState: undefined } as unknown as vscode.ChatSessionContentContext;
    const emit = (text: string): void => updates.fire({ sessionId, update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text },
    } });
    vi.useFakeTimers();
    try {
      const failed = expect(provider.provideChatSessionContent(resource, source.token, context)).rejects.toThrow('RPC failed');
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledOnce();
      const retried = provider.provideChatSessionContent(resource, source.token, context);
      firstResponse.reject(new Error('RPC failed'));
      await vi.advanceTimersByTimeAsync(200);
      emit('failed replay tail');
      await vi.advanceTimersByTimeAsync(200);
      expect(load).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(50);
      await failed;
      expect(load).toHaveBeenCalledTimes(2);
      emit('retried replay');
      await vi.advanceTimersByTimeAsync(250);
      expect((await retried).history).toMatchObject([{ prompt: 'retried replay' }]);
    } finally {
      firstResponse.resolve({ sessionId });
      source.cancel();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      source.dispose();
      provider.dispose();
      controller.dispose();
      updates.dispose();
      disposeBackend();
    }
  });

  it('rejects a replay that never becomes quiet instead of returning partial history', async () => {
    const { backend, disposeBackend } = createFakeBackend([{ sessionId: 'noisy', cwd: '', title: 'Replay' }]);
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    const load = vi.spyOn(backend, 'loadSession');
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const provider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, createFakeOutputChannel());
    const source = new vscode.CancellationTokenSource();
    vi.useFakeTimers();
    try {
      const pending = provider.provideChatSessionContent(buildSessionResource('noisy'), source.token,
        { inputState: undefined } as unknown as vscode.ChatSessionContentContext);
      const rejection = expect(pending).rejects.toThrow(/history may be incomplete/);
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledOnce();
      for (let elapsed = 0; elapsed < 10_000; elapsed += 200) {
        updates.fire({ sessionId: 'noisy', update: { sessionUpdate: 'usage_update', used: 1, size: 2 } });
        await vi.advanceTimersByTimeAsync(200);
      }
      await rejection;
    } finally {
      vi.useRealTimers();
      source.dispose();
      provider.dispose();
      controller.dispose();
      updates.dispose();
      disposeBackend();
    }
  });

  it('continues streaming after prompt response while background work is not idle', async () => {
    const { backend, disposeBackend } = createFakeBackend([{ sessionId: 'background', cwd: '', title: 'Background' }]);
    const idle = Promise.withResolvers<void>();
    const waitForIdle = vi.spyOn(backend, 'waitForConversationFullyIdle').mockReturnValue(idle.promise);
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    const participant = new AgyChatParticipant(backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn() } as unknown as BrowserSubagentRenderer, createFakeOutputChannel());
    const source = new vscode.CancellationTokenSource();
    const stream = { push: vi.fn() } as unknown as vscode.ChatResponseStream;
    const resource = buildSessionResource('background');
    try {
      const running = participant.createHandler()(
        { prompt: 'Start', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Background' }, isUntitled: false } },
        stream, source.token,
      );
      await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledTimes(1));
      expect(participant.getActiveSession('background')).toBeDefined();
      updates.fire({ sessionId: 'background', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after prompt' } } });
      idle.resolve();
      await Promise.resolve();
      updates.fire({ sessionId: 'background', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after idle' } } });
      await running;
      expect(stream.push).toHaveBeenCalledTimes(2);
      expect(participant.getActiveSession('background')).toBeUndefined();
    } finally {
      idle.resolve();
      source.dispose();
      participant.dispose();
      controller.dispose();
      updates.dispose();
      disposeBackend();
    }
  });

  it('fails a turn if the backend disconnects during the final drain even when it reconnects', async () => {
    const sessionId = 'drain-disconnect';
    const { backend, disposeBackend } = createFakeBackend([{ sessionId, cwd: '', title: 'Background' }]);
    const states = new vscode.EventEmitter<{ ready: boolean }>();
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeBackendState: states.event, onDidChangeUpdate: updates.event });
    const waitForIdle = vi.spyOn(backend, 'waitForConversationFullyIdle');
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn() } as unknown as BrowserSubagentRenderer, createFakeOutputChannel());
    const source = new vscode.CancellationTokenSource();
    const push = vi.fn();
    const resource = buildSessionResource(sessionId);
    vi.useFakeTimers();
    try {
      const running = participant.createHandler()(
        { prompt: 'Start', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Background' }, isUntitled: false } },
        { push } as unknown as vscode.ChatResponseStream, source.token,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(waitForIdle).toHaveBeenCalledOnce();
      states.fire({ ready: false });
      states.fire({ ready: true });
      updates.fire({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong stream' } } });
      const result = await running;
      expect(result?.errorDetails?.message).toContain('backend disconnected');
      expect(push).not.toHaveBeenCalled();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Failed);
      expect(participant.getActiveSession(sessionId)).toBeUndefined();
    } finally {
      source.cancel();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      source.dispose();
      participant.dispose();
      controller.dispose();
      updates.dispose();
      states.dispose();
      disposeBackend();
    }
  });

  it('reports a failure instead of completing when backend idle cannot be confirmed', async () => {
    const { backend, disposeBackend } = createFakeBackend([{ sessionId: 'idle-error', cwd: '', title: 'Background' }]);
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockRejectedValue(new Error('HTTP 503'));
    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn() } as unknown as BrowserSubagentRenderer, createFakeOutputChannel());
    const source = new vscode.CancellationTokenSource();
    const resource = buildSessionResource('idle-error');
    try {
      const result = await participant.createHandler()(
        { prompt: 'Start', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Background' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream, source.token,
      );
      expect(result?.errorDetails?.message).toContain('HTTP 503');
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Failed);
      expect(participant.getActiveSession('idle-error')).toBeUndefined();
    } finally {
      source.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
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
