import * as fsPromises from 'node:fs/promises';
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
    public readonly query: string;
    private readonly serialized: string;

    private constructor(
      scheme: string,
      authority: string,
      uriPath: string,
      fsPath: string,
      serialized: string,
      query = '',
    ) {
      this.scheme = scheme;
      this.authority = authority;
      this.path = uriPath;
      this.fsPath = fsPath;
      this.serialized = serialized;
      this.query = query;
    }

    public static file(filePath: string): MockUri {
      const normalized = filePath.replace(/\\/g, '/');
      const uriPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
      return new MockUri('file', '', uriPath, filePath, `file://${encodeURI(uriPath)}`);
    }

    public static from(components: {
      readonly scheme: string;
      readonly path?: string;
      readonly authority?: string;
      readonly query?: string;
    }): MockUri {
      const uriPath = components.path ?? '/';
      const authority = components.authority ?? '';
      const query = components.query ?? '';
      const querySuffix = query.length > 0 ? `?${query}` : '';
      return new MockUri(
        components.scheme,
        authority,
        uriPath,
        uriPath,
        `${components.scheme}:${uriPath}${querySuffix}`,
        query,
      );
    }

    public static parse(raw: string): MockUri {
      const noHash = raw.split('#')[0] ?? raw;
      const qIdx = noHash.indexOf('?');
      const beforeQuery = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
      const query = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
      const cIdx = beforeQuery.indexOf(':');
      const scheme = cIdx >= 0 ? beforeQuery.slice(0, cIdx) : 'file';
      let rest = cIdx >= 0 ? beforeQuery.slice(cIdx + 1) : beforeQuery;
      let authority = '';
      if (rest.startsWith('//')) {
        rest = rest.slice(2);
        const slashIdx = rest.indexOf('/');
        authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
        rest = slashIdx >= 0 ? rest.slice(slashIdx) : '/';
      }
      return new MockUri(scheme, authority, rest, rest, raw, query);
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
    ChatResponseThinkingProgressPart: class {
      public constructor(public readonly value: string | string[]) {}
    },
    ChatToolInvocationPart: class {
      public isComplete = false;
      public isError = false;
      public isConfirmed?: boolean;
      public enablePartialUpdate = false;
      public invocationMessage?: string | { value: string };
      public pastTenseMessage?: string | { value: string };
      public toolSpecificData?: Record<string, unknown>;
      public constructor(public readonly toolName: string, public readonly toolCallId: string, public readonly errorMessage?: string) {}
    },
    MarkdownString: class {
      public constructor(public readonly value = '') {}
      public appendCodeblock(): this { return this; }
      public appendMarkdown(): this { return this; }
      public appendText(): this { return this; }
    },
    LanguageModelTextPart: class {
      public constructor(public readonly value: string) {}
    },
    LanguageModelToolResult: class {
      public constructor(public readonly content: unknown[]) {}
    },
    ChatQuestionType: { Text: 1, SingleSelect: 2, MultiSelect: 3 },
    lm: { invokeTool: vi.fn() },
    window: { showQuickPick: vi.fn(), showInputBox: vi.fn() },
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
import type {
  AcpElicitRequestParams,
  AcpElicitResult,
  AcpRequestPermissionParams,
  AcpSessionPromptResult,
  AcpSessionSummary,
  AcpSessionUpdate,
} from '../../src/acp/acpTypes.js';
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
import type {
  AcpBackendInterface,
  ElicitationPrompt,
  PermissionPrompt,
  QuotaServiceInterface,
} from '../../src/shared/contracts.js';

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

    const modeGroup1 = state1.groups[0];
    expect(modeGroup1?.items.map((item) => item.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);
    expect((modeGroup1?.items[0] as { agyPickerMeta?: unknown })?.agyPickerMeta).toMatchObject({
      provider: 'antigravity',
      category: 'permission',
      pickerLabel: 'Manual permissions',
      shortLabel: 'Manual',
      tone: '',
      lastInteractiveMode: 'default',
    });
    expect((modeGroup1?.items[2] as { agyPickerMeta?: unknown })?.agyPickerMeta).toMatchObject({
      pickerLabel: 'Auto',
      shortLabel: 'Auto',
      tone: 'warning',
    });

    // Switching from accept-edits to plan retains accept-edits as lastInteractiveMode
    controller.setSessionMode('sess-1', 'accept-edits');
    controller.setSessionMode('sess-1', 'plan');
    expect(controller.getLastInteractiveMode('sess-1')).toBe('accept-edits');

    const stateAfterPlan = handler?.(buildSessionResource('sess-1'), undefined, cancellationToken) as vscode.ChatSessionInputState;
    expect((stateAfterPlan.groups[0]?.selected as { agyPickerMeta?: unknown })?.agyPickerMeta).toMatchObject({
      pickerLabel: 'Plan',
      lastInteractiveMode: 'accept-edits',
    });

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

    // In Agents Window (no workspace folders, isAgentSessionsWorkspace = true), keep all project sessions + empty cwd.
    ws.workspaceFolders = undefined;
    ws.isAgentSessionsWorkspace = true;
    await controller.refreshSessions();
    expect(collectIds()).toEqual(['s-proj-a', 's-proj-a-sub', 's-proj-b', 's-scratch', 's-empty']);
    const projAItem = controller.controller.items.get(buildSessionResource('s-proj-a'));
    const emptyItem = controller.controller.items.get(buildSessionResource('s-empty'));
    expect(projAItem?.metadata).toEqual({
      workingDirectoryPath: normalizeAcpCwd(projectA),
      cwd: normalizeAcpCwd(projectA),
    });
    expect(emptyItem?.metadata).toBeUndefined();
    await expect(controller.getSessionCwd('s-proj-a')).resolves.toBe(normalizeAcpCwd(projectA));
    await expect(controller.getSessionCwd('s-empty')).resolves.toBe('');

    const agentsOutput = createFakeOutputChannel();
    const agentsContentProvider = new AgySessionContentProvider(backend, controller, {} as BrowserSubagentRenderer, agentsOutput);
    const agentsToken = new vscode.CancellationTokenSource();
    const agentsDraftResource = buildSessionResource('untitled-agents');
    await agentsContentProvider.provideHandleOptionsChange(
      agentsDraftResource,
      [{ optionId: 'folder', value: projectASub }],
      agentsToken.token,
    );
    await expect(controller.getSessionCwd('untitled-agents')).resolves.toBe(normalizeAcpCwd(projectASub));

    const newItemFromAgentsWindow = (
      controller as unknown as {
        handleNewChatSessionItem: (
          context: vscode.NewChatSessionItemContext,
          token: vscode.CancellationToken,
        ) => vscode.ChatSessionItem;
      }
    ).handleNewChatSessionItem(
      {
        request: { prompt: 'hello' } as unknown as vscode.ChatRequest,
        sessionOptions: [{ optionId: 'folder', value: projectB }],
      },
      agentsToken.token,
    );
    const createdAgentsId = newItemFromAgentsWindow.resource.path.replace(/^\/+/, '');
    await expect(controller.getSessionCwd(createdAgentsId)).resolves.toBe(normalizeAcpCwd(projectB));
    expect(newItemFromAgentsWindow.metadata).toEqual({
      workingDirectoryPath: normalizeAcpCwd(projectB),
      cwd: normalizeAcpCwd(projectB),
    });
    agentsContentProvider.dispose();
    agentsToken.dispose();

    ws.isAgentSessionsWorkspace = false;
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

  it('uses built-in Copilot SDK confirmation tools for single, concurrent, and non-terminal permissions, with carousel fallback', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'perm-sess', cwd: 'D:\\repo', title: 'Perm Session' },
    ]);
    const finish = Promise.withResolvers<AcpSessionPromptResult>();
    backend.prompt = vi.fn(() => finish.promise);
    backend.waitForConversationFullyIdle = vi.fn(async () => {});
    let ask: PermissionPrompt | undefined;
    backend.registerPermissionPrompt = (_id, handler) => {
      ask = handler;
      return { dispose: () => { ask = undefined; } };
    };

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend,
      controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn() } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const invokeToolMock = vi.mocked(vscode.lm.invokeTool);
    invokeToolMock.mockReset();

    const source = new vscode.CancellationTokenSource();
    const resource = buildSessionResource('perm-sess');
    const token = { token: 'tool-token-1' } as unknown as vscode.ChatParticipantToolToken;
    const questionCarousel = vi.fn<NonNullable<vscode.ChatResponseStream['questionCarousel']>>(async () => ({}));
    const running = participant.createHandler()(
      { prompt: 'Run checks', references: [], toolReferences: [], toolInvocationToken: token } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Perm Session' }, isUntitled: false } },
      { push: vi.fn(), questionCarousel } as unknown as vscode.ChatResponseStream,
      source.token,
    );

    try {
      await vi.waitFor(() => expect(ask).toBeDefined());

      const firstResolver = Promise.withResolvers<vscode.LanguageModelToolResult>();
      const secondResolver = Promise.withResolvers<vscode.LanguageModelToolResult>();
      invokeToolMock
        .mockReturnValueOnce(firstResolver.promise)
        .mockReturnValueOnce(secondResolver.promise)
        .mockResolvedValueOnce(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('no')]))
        .mockRejectedValueOnce(new Error('Tool vscode_get_terminal_confirmation was not contributed'));

      const p1 = ask?.({
        sessionId: 'perm-sess',
        toolCall: { toolCallId: 'cmd-1', kind: 'execute', name: 'run_command', title: 'Run git status', rawInput: { CommandLine: 'git status', Cwd: 'D:\\repo' } },
        options: [
          { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
        ],
      });
      const p2 = ask?.({
        sessionId: 'perm-sess',
        toolCall: { toolCallId: 'cmd-2', kind: 'execute', name: 'run_command', title: 'Run npm test', rawInput: { CommandLine: 'npm test', Cwd: 'D:\\repo' } },
        options: [
          { optionId: 'allow-2', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-2', kind: 'reject_once', name: 'Reject' },
        ],
      });

      expect(invokeToolMock).toHaveBeenCalledTimes(2);
      expect(invokeToolMock).toHaveBeenNthCalledWith(
        1,
        'vscode_get_terminal_confirmation',
        expect.objectContaining({
          toolInvocationToken: token,
          input: expect.objectContaining({ command: 'git status', mode: 'sync', isBackground: false }),
        }),
        expect.anything(),
      );
      expect(invokeToolMock).toHaveBeenNthCalledWith(
        2,
        'vscode_get_terminal_confirmation',
        expect.objectContaining({
          toolInvocationToken: token,
          input: expect.objectContaining({ command: 'npm test', mode: 'sync', isBackground: false }),
        }),
        expect.anything(),
      );

      firstResolver.resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('yes')]));
      secondResolver.resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('no')]));
      await expect(p1).resolves.toBe('allow-1');
      await expect(p2).resolves.toBe('reject-2');

      const p3 = ask?.({
        sessionId: 'perm-sess',
        toolCall: { toolCallId: 'edit-1', kind: 'edit', name: 'write_file', title: 'Write config.json' },
        options: [
          { optionId: 'allow-3', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-3', kind: 'reject_once', name: 'Reject' },
        ],
      });
      await expect(p3).resolves.toBe('reject-3');
      expect(invokeToolMock).toHaveBeenNthCalledWith(
        3,
        'vscode_get_confirmation',
        expect.objectContaining({
          toolInvocationToken: token,
          input: expect.objectContaining({ title: 'Write config.json', confirmationType: 'basic' }),
        }),
        expect.anything(),
      );

      questionCarousel.mockImplementationOnce(async (questions: readonly vscode.ChatQuestion[]) => {
        const qId = questions[0]?.id ?? '';
        return { [qId]: 'allow-4' };
      });
      const p4 = ask?.({
        sessionId: 'perm-sess',
        toolCall: { toolCallId: 'cmd-4', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'dir' } },
        options: [
          { optionId: 'allow-4', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-4', kind: 'reject_once', name: 'Reject' },
        ],
      });
      await expect(p4).resolves.toBe('allow-4');
      expect(questionCarousel).toHaveBeenCalledOnce();
    } finally {
      finish.resolve({ stopReason: 'end_turn' });
      await running;
      source.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('steers a concurrent request into a running or reattached session without rejecting', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'steer-sess', cwd: 'D:\\repo', title: 'Steer Session' },
    ]);
    const firstFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const secondFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt')
      .mockReturnValueOnce(firstFinish.promise)
      .mockReturnValueOnce(secondFinish.promise);
    const cancel = vi.spyOn(backend, 'cancel');
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });

    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const browser = { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer;
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      browser, output,
    );
    const provider = new AgySessionContentProvider(
      backend, controller, browser, output, undefined, (id) => participant.getActiveSession(id),
    );
    const resource = buildSessionResource('steer-sess');
    const source1 = new vscode.CancellationTokenSource();
    const source2 = new vscode.CancellationTokenSource();
    const historyToken = new vscode.CancellationTokenSource();
    const stop1 = new vscode.CancellationTokenSource();
    const stream1 = { push: vi.fn() } as unknown as vscode.ChatResponseStream;
    const reopened1 = { push: vi.fn() } as unknown as vscode.ChatResponseStream;
    const stream2 = { push: vi.fn() } as unknown as vscode.ChatResponseStream;
    const inputState = controller.controller.createChatSessionInputState([]);

    const turn1 = participant.createHandler()(
      { prompt: 'First task', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Steer Session' }, isUntitled: false } },
      stream1, source1.token,
    );
    let turn2: vscode.ProviderResult<void | vscode.ChatResult>;
    let attached1: Thenable<void> | void;

    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const content = await provider.provideChatSessionContent(resource, historyToken.token, { inputState });
      attached1 = content.activeResponseCallback?.(reopened1, stop1.token);

      updates.fire({
        sessionId: 'steer-sess',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-cmd-1',
          kind: 'execute',
          name: 'run_command',
          title: 'Run build',
          rawInput: { CommandLine: 'npm run build' },
          status: 'in_progress',
        },
      });
      expect(reopened1.push).toHaveBeenCalledTimes(1);

      turn2 = participant.createHandler()(
        { prompt: 'Follow up steer', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Steer Session' }, isUntitled: false } },
        stream2, source2.token,
      );

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      expect(cancel).not.toHaveBeenCalled();
      await attached1;

      updates.fire({
        sessionId: 'steer-sess',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after steer' } },
      });
      updates.fire({
        sessionId: 'steer-sess',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-cmd-1',
          status: 'completed',
          rawOutput: { exitCode: 0 },
        },
      });

      expect(reopened1.push).toHaveBeenCalledTimes(1);
      expect(stream2.push).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: { value: 'after steer' } }));
      expect(stream2.push).toHaveBeenNthCalledWith(2, expect.objectContaining({
        toolCallId: 'tool-cmd-1',
        isComplete: true,
        toolSpecificData: expect.objectContaining({
          commandLine: expect.objectContaining({ original: 'npm run build' }),
        }),
      }));

      // Superseded turn1 settling early must not mark the still-running session Completed.
      firstFinish.resolve({ stopReason: 'end_turn' });
      const res1 = await turn1;
      expect(res1?.errorDetails).toBeUndefined();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.InProgress);

      secondFinish.resolve({ stopReason: 'end_turn' });
      const res2 = await turn2;
      expect(res2?.errorDetails).toBeUndefined();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Completed);
      expect(participant.getActiveSession('steer-sess')).toBeUndefined();
    } finally {
      firstFinish.resolve({ stopReason: 'end_turn' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      await turn1;
      await turn2;
      source1.dispose();
      source2.dispose();
      historyToken.dispose();
      stop1.dispose();
      updates.dispose();
      provider.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('yields cleanly on context.yieldRequested once permissions clear and buffers gap updates for the next turn', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'yield-sess', cwd: 'D:\\repo', title: 'Yield Session' },
    ]);
    const firstFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const secondFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt')
      .mockReturnValueOnce(firstFinish.promise)
      .mockReturnValueOnce(secondFinish.promise);
    const cancel = vi.spyOn(backend, 'cancel');
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });
    let ask: PermissionPrompt | undefined;
    backend.registerPermissionPrompt = (_id, handler) => {
      ask = handler;
      return { dispose: () => { ask = undefined; } };
    };

    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer, output,
    );

    const resource = buildSessionResource('yield-sess');
    const source1 = new vscode.CancellationTokenSource();
    const source2 = new vscode.CancellationTokenSource();
    let carouselId = '';
    const carousel = Promise.withResolvers<Record<string, unknown> | undefined>();
    const stream1 = {
      push: vi.fn(),
      questionCarousel: vi.fn((questions: readonly vscode.ChatQuestion[]) => {
        carouselId = questions[0]?.id ?? '';
        return carousel.promise;
      }),
    } as unknown as vscode.ChatResponseStream;
    const stream2 = { push: vi.fn() } as unknown as vscode.ChatResponseStream;

    let yieldFlag = false;
    const context1 = {
      history: [],
      chatSessionContext: { chatSessionItem: { resource, label: 'Yield Session' }, isUntitled: false },
      get yieldRequested(): boolean { return yieldFlag; },
    };

    const turn1 = participant.createHandler()(
      { prompt: 'Run long task', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      context1, stream1, source1.token,
    );
    let turn2: vscode.ProviderResult<void | vscode.ChatResult>;

    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(ask).toBeDefined());

      const permPromise = ask?.({
        sessionId: 'yield-sess',
        toolCall: { toolCallId: 'cmd-y1', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'npm test' } },
        options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
      });
      await vi.waitFor(() => expect(stream1.questionCarousel).toHaveBeenCalledOnce());
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.NeedsInput);

      yieldFlag = true;
      let yieldedEarly = false;
      void Promise.resolve(turn1).then(() => { yieldedEarly = true; });
      await new Promise((resolve) => setTimeout(resolve, 130));
      expect(yieldedEarly).toBe(false);

      carousel.resolve({ [carouselId]: 'allow-1' });
      await expect(permPromise).resolves.toBe('allow-1');

      const res1 = await turn1;
      expect(res1?.metadata).toMatchObject({ sessionId: 'yield-sess', yielded: true });
      expect(cancel).not.toHaveBeenCalled();

      // Gap update after yield must be buffered rather than pushed to turn1's finished stream.
      updates.fire({
        sessionId: 'yield-sess',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'during gap' } },
      });
      expect(stream1.push).not.toHaveBeenCalled();

      turn2 = participant.createHandler()(
        { prompt: 'Steer now', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Yield Session' }, isUntitled: false } },
        stream2, source2.token,
      );

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      updates.fire({
        sessionId: 'yield-sess',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after handoff' } },
      });

      expect(stream2.push).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: { value: 'during gap' } }));
      expect(stream2.push).toHaveBeenNthCalledWith(2, expect.objectContaining({ value: { value: 'after handoff' } }));

      firstFinish.resolve({ stopReason: 'end_turn' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      const res2 = await turn2;
      expect(res2?.errorDetails).toBeUndefined();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Completed);
    } finally {
      carousel.resolve(undefined);
      firstFinish.resolve({ stopReason: 'end_turn' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      await turn1;
      await turn2;
      source1.dispose();
      source2.dispose();
      updates.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('waits while a stopping turn is cancelling and aborts cleanly if the waiting request is cancelled', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'cancel-wait-sess', cwd: 'D:\\repo', title: 'Cancel Wait' },
    ]);
    const firstFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const secondFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt')
      .mockReturnValueOnce(firstFinish.promise)
      .mockReturnValueOnce(secondFinish.promise);
    const cancel = vi.spyOn(backend, 'cancel');
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const resource = buildSessionResource('cancel-wait-sess');
    const source1 = new vscode.CancellationTokenSource();
    const source2a = new vscode.CancellationTokenSource();
    const source2b = new vscode.CancellationTokenSource();
    const turn1 = participant.createHandler()(
      { prompt: 'First', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Cancel Wait' }, isUntitled: false } },
      { push: vi.fn() } as unknown as vscode.ChatResponseStream, source1.token,
    );
    let turn2a: vscode.ProviderResult<void | vscode.ChatResult>;
    let turn2b: vscode.ProviderResult<void | vscode.ChatResult>;

    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      source1.cancel();
      expect(cancel).toHaveBeenCalledExactlyOnceWith('cancel-wait-sess');

      turn2a = participant.createHandler()(
        { prompt: 'Waiter A', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Cancel Wait' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream, source2a.token,
      );
      turn2b = participant.createHandler()(
        { prompt: 'Waiter B', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Cancel Wait' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream, source2b.token,
      );

      await Promise.resolve();
      expect(prompt).toHaveBeenCalledTimes(1);

      source2a.cancel();
      const res2a = await turn2a;
      expect(res2a).toEqual({});
      expect(prompt).toHaveBeenCalledTimes(1);

      firstFinish.resolve({ stopReason: 'cancelled' });
      await turn1;

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      secondFinish.resolve({ stopReason: 'end_turn' });
      const res2b = await turn2b;
      expect(res2b?.errorDetails).toBeUndefined();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Completed);
    } finally {
      firstFinish.resolve({ stopReason: 'cancelled' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      await turn1;
      await turn2a;
      await turn2b;
      source1.dispose();
      source2a.dispose();
      source2b.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('waits while a turn has an active permission prompt before steering the follow-up prompt', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'perm-wait-sess', cwd: 'D:\\repo', title: 'Perm Wait' },
    ]);
    const firstFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const secondFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt')
      .mockReturnValueOnce(firstFinish.promise)
      .mockReturnValueOnce(secondFinish.promise);
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();
    let ask: PermissionPrompt | undefined;
    backend.registerPermissionPrompt = (_id, handler) => {
      ask = handler;
      return { dispose: () => { ask = undefined; } };
    };

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const resource = buildSessionResource('perm-wait-sess');
    const source1 = new vscode.CancellationTokenSource();
    const source2 = new vscode.CancellationTokenSource();
    let carouselId = '';
    const carousel = Promise.withResolvers<Record<string, unknown> | undefined>();
    const stream1 = {
      push: vi.fn(),
      questionCarousel: vi.fn((questions: readonly vscode.ChatQuestion[]) => {
        carouselId = questions[0]?.id ?? '';
        return carousel.promise;
      }),
    } as unknown as vscode.ChatResponseStream;
    const turn1 = participant.createHandler()(
      { prompt: 'Run tool', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Perm Wait' }, isUntitled: false } },
      stream1, source1.token,
    );
    let turn2: vscode.ProviderResult<void | vscode.ChatResult>;

    try {
      await vi.waitFor(() => expect(ask).toBeDefined());
      const permPromise = ask?.({
        sessionId: 'perm-wait-sess',
        toolCall: { toolCallId: 'cmd-p1', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'npm check' } },
        options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
      });
      await vi.waitFor(() => expect(stream1.questionCarousel).toHaveBeenCalledOnce());

      turn2 = participant.createHandler()(
        { prompt: 'Follow-up', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Perm Wait' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream, source2.token,
      );

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(prompt).toHaveBeenCalledTimes(1);

      carousel.resolve({ [carouselId]: 'allow-1' });
      await expect(permPromise).resolves.toBe('allow-1');

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      firstFinish.resolve({ stopReason: 'end_turn' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      const res2 = await turn2;
      expect(res2?.errorDetails).toBeUndefined();
      await turn1;
    } finally {
      carousel.resolve(undefined);
      firstFinish.resolve({ stopReason: 'end_turn' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      await turn1;
      await turn2;
      source1.dispose();
      source2.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('retries prompt when backend reports the previous prompt is still being cancelled', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'retry-sess', cwd: 'D:\\repo', title: 'Retry' },
    ]);
    const prompt = vi.spyOn(backend, 'prompt')
      .mockRejectedValueOnce(new Error('the running prompt is being cancelled; wait for it to finish, then send this prompt again'))
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const resource = buildSessionResource('retry-sess');
    const source = new vscode.CancellationTokenSource();
    vi.useFakeTimers();
    try {
      const pending = participant.createHandler()(
        { prompt: 'Retry prompt', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Retry' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream, source.token,
      );
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(300);
      const res = await pending;
      expect(res?.errorDetails).toBeUndefined();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Completed);
    } finally {
      vi.useRealTimers();
      source.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('aborts an active idle wait without cancelling the backend when a follow-up request steers in', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'idle-steer-sess', cwd: 'D:\\repo', title: 'Idle Steer' },
    ]);
    const idle1 = Promise.withResolvers<void>();
    const secondPrompt = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt')
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockReturnValueOnce(secondPrompt.promise);
    const waitForIdle = vi.spyOn(backend, 'waitForConversationFullyIdle')
      .mockReturnValueOnce(idle1.promise)
      .mockResolvedValueOnce();
    const cancel = vi.spyOn(backend, 'cancel');

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const resource = buildSessionResource('idle-steer-sess');
    const source1 = new vscode.CancellationTokenSource();
    const source2 = new vscode.CancellationTokenSource();
    const turn1 = participant.createHandler()(
      { prompt: 'Background start', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Idle Steer' }, isUntitled: false } },
      { push: vi.fn() } as unknown as vscode.ChatResponseStream, source1.token,
    );
    let turn2: vscode.ProviderResult<void | vscode.ChatResult>;

    try {
      await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledTimes(1));
      const idleToken = waitForIdle.mock.calls[0]?.[1];
      expect(idleToken?.isCancellationRequested).toBe(false);

      turn2 = participant.createHandler()(
        { prompt: 'Steer during idle', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Idle Steer' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream, source2.token,
      );

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      expect(cancel).not.toHaveBeenCalled();
      expect(idleToken?.isCancellationRequested).toBe(true);

      idle1.reject(new Error('Idle wait cancelled'));
      const res1 = await turn1;
      expect(res1?.errorDetails).toBeUndefined();

      secondPrompt.resolve({ stopReason: 'end_turn' });
      const res2 = await turn2;
      expect(res2?.errorDetails).toBeUndefined();
      expect(controller.controller.items.get(resource)?.status).toBe(vscode.ChatSessionStatus.Completed);
    } finally {
      idle1.resolve();
      secondPrompt.resolve({ stopReason: 'end_turn' });
      await turn1;
      await turn2;
      source1.dispose();
      source2.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('creates /btw side chat sessions with in-flight context, forwards slash commands, and syncs Keep/Undo actions', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'main-sess-1', cwd: 'D:\\repo', title: 'Main Feature' },
    ]);
    const acknowledgeCalls: Array<{ id: string; uri: string; contents: string; accept: boolean }> = [];
    backend.acknowledgeCodeEdit = async (id, uri, contents, accept) => {
      acknowledgeCalls.push({ id, uri, contents, accept });
      return true;
    };
    const promptCalls: Array<{ sessionId: string; blocks: unknown[] }> = [];
    vi.spyOn(backend, 'prompt').mockImplementation(async (sessionId, blocks) => {
      promptCalls.push({ sessionId, blocks });
      return { stopReason: 'end_turn' };
    });

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend,
      controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const mainResource = buildSessionResource('main-sess-1');
    const source = new vscode.CancellationTokenSource();
    try {
      controller.recordTurnContext('main-sess-1', 'Build feature X', 'Updated files cleanly.');
      controller.registerActiveTurnSnapshotProvider((id) =>
        id === 'main-sess-1' ? { userPrompt: 'Refactor module Y', assistantPartialResponse: 'Editing index.ts...' } : undefined,
      );

      const sideItem = await controller.createForkOrSideChatSession(
        mainResource,
        {
          prompt: JSON.stringify({
            sideChat: true,
            turnId: 'turn-2',
            selection: 'const x = 42;',
            includeSourceContext: true,
          }),
          command: 'btw',
        } as unknown as vscode.ChatRequestTurn,
        source.token,
      );
      expect(sideItem.label).toBe('Side Chat: Main Feature');

      await participant.createHandler()(
        { prompt: 'Why 42?', command: 'btw', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: sideItem, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream,
        source.token,
      );
      expect(promptCalls).toHaveLength(1);
      const sentText = (promptCalls[0]?.blocks[0] as { text?: string } | undefined)?.text ?? '';
      expect(sentText).toContain('<in_flight_main_turn>');
      expect(sentText).toContain('Refactor module Y');
      expect(sentText).toContain('<selected_excerpt>');
      expect(sentText).toContain('const x = 42;');
      expect(sentText).toContain('Why 42?');

      // Subsequent regular prompt should reconstruct non-plan command (/compact) without side-chat preamble
      await participant.createHandler()(
        { prompt: 'focus on API', command: 'compact', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource: mainResource, label: 'Main Feature' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream,
        source.token,
      );
      const secondText = (promptCalls[1]?.blocks[0] as { text?: string } | undefined)?.text ?? '';
      expect(secondText).toBe('/compact focus on API');

      // Keep/Undo synchronization with session changes and AcknowledgeCascadeCodeEdit
      const fileA = vscode.Uri.file('D:\\repo\\src\\a.ts');
      const fileB = vscode.Uri.file('D:\\repo\\src\\b.ts');
      controller.setSessionChanges('main-sess-1', [
        { uri: fileA, originalUri: fileA, modifiedUri: fileA, insertions: 2, deletions: 0 },
        { uri: fileB, originalUri: fileB, modifiedUri: fileB, insertions: 1, deletions: 1 },
      ]);
      await controller.handleEditingAction(mainResource, { uri: fileA, outcome: 'rejected' });
      expect(controller.controller.items.get(mainResource)?.changes?.map((c) => c.modifiedUri.toString())).toEqual([
        fileB.toString(),
      ]);
      await vi.waitFor(() => expect(acknowledgeCalls).toHaveLength(1));
      expect(acknowledgeCalls[0]).toMatchObject({ id: 'main-sess-1', accept: false });
    } finally {
      source.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('preserves pending invokeTool command permission and ask_question elicitation across exit and re-entry without auto-rejecting', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'persist-sess', cwd: 'D:\\repo', title: 'Persist Session' },
    ]);
    const finish = Promise.withResolvers<AcpSessionPromptResult>();
    vi.spyOn(backend, 'prompt').mockReturnValue(finish.promise);
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();

    let askPermission: PermissionPrompt | undefined;
    backend.registerPermissionPrompt = (_id, handler) => {
      askPermission = handler;
      return { dispose: () => { askPermission = undefined; } };
    };
    let askElicitation: ElicitationPrompt | undefined;
    backend.registerElicitationPrompt = (_id, handler) => {
      askElicitation = handler;
      return { dispose: () => { askElicitation = undefined; } };
    };

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend,
      controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );
    const contentProvider = new AgySessionContentProvider(
      backend,
      controller,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
      undefined,
      (id) => participant.getActiveSession(id),
    );

    const resource = buildSessionResource('persist-sess');
    const source = new vscode.CancellationTokenSource();
    const reopenedStop = new vscode.CancellationTokenSource();
    const historyToken = new vscode.CancellationTokenSource();
    const toolToken = { token: 'tool-tok-1' } as unknown as vscode.ChatParticipantToolToken;
    const initialCarouselDeferred = Promise.withResolvers<Record<string, unknown> | undefined>();
    const reopenedCarouselDeferred = Promise.withResolvers<Record<string, unknown> | undefined>();
    const firstStream = {
      push: vi.fn(),
      questionCarousel: vi.fn(() => initialCarouselDeferred.promise),
    } as unknown as vscode.ChatResponseStream;
    const reopenedStream = {
      push: vi.fn(),
      questionCarousel: vi.fn(() => reopenedCarouselDeferred.promise),
    } as unknown as vscode.ChatResponseStream;

    const invokeToolMock = vi.mocked(vscode.lm.invokeTool);
    invokeToolMock.mockReset();
    const pendingTool = Promise.withResolvers<vscode.LanguageModelToolResult>();
    invokeToolMock.mockReturnValueOnce(pendingTool.promise);

    const turnPromise = participant.createHandler()(
      { prompt: 'Deploy & ask', references: [], toolReferences: [], toolInvocationToken: toolToken } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Persist Session' }, isUntitled: false } },
      firstStream,
      source.token,
    );

    let attached: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(askPermission).toBeDefined());
      await vi.waitFor(() => expect(askElicitation).toBeDefined());

      let settledPermission: string | undefined;
      const permPromise = askPermission?.({
        sessionId: 'persist-sess',
        toolCall: { toolCallId: 'cmd-persist', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'npm run build' } },
        options: [
          { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
        ],
      }).then((choice) => {
        settledPermission = choice;
        return choice;
      });
      await vi.waitFor(() => expect(invokeToolMock).toHaveBeenCalledOnce());

      // User exits the session while confirmation is open -> invokeTool rejects with Canceled, but MUST NOT auto-reject.
      pendingTool.reject(new vscode.CancellationError());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settledPermission).toBeUndefined();

      // Elicitation (ask_question) arrives cleanly too.
      const elicitReq: AcpElicitRequestParams = {
        sessionId: 'persist-sess',
        mode: 'form',
        message: 'The agent has a question.',
        requestedSchema: {
          type: 'object',
          properties: {
            q0: {
              type: 'string',
              title: 'Framework?',
              oneOf: [
                { const: 'vitest', title: 'Vitest' },
                { const: 'jest', title: 'Jest' },
              ],
            },
            q0_other: { type: 'string', description: 'Optional free-form answer to: Framework?' },
          },
          required: ['q0'],
        },
      };
      const elicitPromise = askElicitation?.(elicitReq);

      // Re-enter session -> ActiveAgyTurn.attach re-emits BOTH interactive carousels on reopenedStream!
      const content = await contentProvider.provideChatSessionContent(resource, historyToken.token, {
        inputState: controller.controller.createChatSessionInputState([]),
      });
      attached = Promise.resolve(content.activeResponseCallback?.(reopenedStream, reopenedStop.token));

      await vi.waitFor(() => expect(reopenedStream.questionCarousel).toHaveBeenCalledTimes(2));
      const permQuestions = (reopenedStream.questionCarousel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as vscode.ChatQuestion[];
      const elicitQuestions = (reopenedStream.questionCarousel as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as vscode.ChatQuestion[];
      const permQId = permQuestions[0]?.id ?? '';
      const elicitQId = elicitQuestions[0]?.id ?? '';
      expect(permQId.startsWith('agy-terminal:')).toBe(true);
      expect(elicitQuestions[0]?.allowFreeformInput).toBe(true);

      // Answer both via the restored UI command bridge!
      expect(participant.resolvePendingCarousel({ questionIds: [permQId], answers: { [permQId]: 'allow-1' } })).toBe(true);
      expect(
        participant.resolvePendingCarousel({
          questionIds: [elicitQId],
          answers: { [elicitQId]: { selectedValue: 'vitest', freeformValue: 'with coverage' } },
        }),
      ).toBe(true);

      await expect(permPromise).resolves.toBe('allow-1');
      await expect(elicitPromise).resolves.toEqual({
        action: 'accept',
        content: { q0: 'vitest', q0_other: 'with coverage' },
      } satisfies AcpElicitResult);

      finish.resolve({ stopReason: 'end_turn' });
      await turnPromise;
      await attached;
    } finally {
      initialCarouselDeferred.resolve(undefined);
      reopenedCarouselDeferred.resolve(undefined);
      pendingTool.reject(new vscode.CancellationError());
      finish.resolve({ stopReason: 'end_turn' });
      await turnPromise;
      await attached;
      source.dispose();
      reopenedStop.dispose();
      historyToken.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('waits until active thinking and in-flight tool calls complete at a step boundary before yielding to steering', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'step-yield-sess', cwd: 'D:\\repo', title: 'Step Yield' },
    ]);
    const firstFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const secondFinish = Promise.withResolvers<AcpSessionPromptResult>();
    const prompt = vi.spyOn(backend, 'prompt')
      .mockReturnValueOnce(firstFinish.promise)
      .mockReturnValueOnce(secondFinish.promise);
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();
    const updates = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
    Object.assign(backend, { onDidChangeUpdate: updates.event });

    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend, controller,
      { resolveModelAndEffort: () => ({ modelValue: '', thoughtLevel: '' }) } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      output,
    );

    const resource = buildSessionResource('step-yield-sess');
    const source1 = new vscode.CancellationTokenSource();
    const source2 = new vscode.CancellationTokenSource();
    const yieldableContext1: vscode.ChatContext & { yieldRequested?: boolean } = {
      history: [],
      yieldRequested: false,
      chatSessionContext: { chatSessionItem: { resource, label: 'Step Yield' }, isUntitled: false },
    };

    const turn1 = participant.createHandler()(
      { prompt: 'Analyze code', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
      yieldableContext1,
      { push: vi.fn() } as unknown as vscode.ChatResponseStream,
      source1.token,
    );
    let turn2: vscode.ProviderResult<void | vscode.ChatResult>;

    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

      // Active thinking followed by an in-progress tool call.
      updates.fire({
        sessionId: 'step-yield-sess',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning verification...' } },
      });
      updates.fire({
        sessionId: 'step-yield-sess',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-step-1',
          kind: 'execute',
          name: 'run_command',
          status: 'in_progress',
          rawInput: { CommandLine: 'npm test' },
        },
      });

      // User queues a Steering ("引导") message mid-tool-call.
      yieldableContext1.yieldRequested = true;
      turn2 = participant.createHandler()(
        { prompt: 'Focus on shader path', references: [], toolReferences: [] } as unknown as vscode.ChatRequest,
        { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Step Yield' }, isUntitled: false } },
        { push: vi.fn() } as unknown as vscode.ChatResponseStream,
        source2.token,
      );

      // Must NOT interrupt while the tool call is still in_progress.
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(prompt).toHaveBeenCalledTimes(1);

      // Complete the tool call -> hits safe step boundary and yields immediately!
      updates.fire({
        sessionId: 'step-yield-sess',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-step-1',
          status: 'completed',
          rawOutput: { exitCode: 0 },
        },
      });

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      const res1 = await turn1;
      expect(res1?.metadata).toMatchObject({ sessionId: 'step-yield-sess', yielded: true });

      secondFinish.resolve({ stopReason: 'end_turn' });
      const res2 = await turn2;
      expect(res2?.errorDetails).toBeUndefined();
    } finally {
      firstFinish.resolve({ stopReason: 'end_turn' });
      secondFinish.resolve({ stopReason: 'end_turn' });
      await turn1;
      await turn2;
      source1.dispose();
      source2.dispose();
      updates.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });

  it('filters registered subagent IDs from controller items and loads subagent transcripts on demand', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const tmpBrain = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'agy-sub-brain-'));
    const subId = 'sub-hidden-1';
    const subLogDir = nodePath.join(tmpBrain, subId, '.system_generated', 'logs');
    await fsPromises.mkdir(subLogDir, { recursive: true });
    await fsPromises.writeFile(
      nodePath.join(subLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          content: '<SYSTEM_MESSAGE>\ncontent=Find shader uniform bug\n</SYSTEM_MESSAGE>',
          created_at: '2026-11-24T11:00:00.000Z',
        }),
        JSON.stringify({
          step_index: 1,
          model: 'Gemini 4 Neon',
          input_tokens: 900,
          cache_read_tokens: 100,
          output_tokens: 60,
          created_at: '2026-11-24T11:00:02.000Z',
          content: 'Verified shader uniform binding.',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'main-parent-1', cwd: 'D:\\repo', title: 'Main Parent' },
      { sessionId: subId, cwd: 'D:\\repo', title: 'Hidden Child Subagent' },
    ]);
    const output = createFakeOutputChannel();
    const controller = new AgySessionController(backend, output, nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    controller.registerSubagentSessionId(subId);
    await controller.refreshSessions();

    expect(controller.controller.items.get(buildSessionResource('main-parent-1'))).toBeDefined();
    expect(controller.controller.items.get(buildSessionResource(subId))).toBeUndefined();

    const contentProvider = new AgySessionContentProvider(
      backend,
      controller,
      { isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      output,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tmpBrain,
    );
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const subDirect = await contentProvider.provideChatSessionContent(
        vscode.Uri.parse(`antigravity:/subagent/${subId}`),
        tokenSource.token,
        { inputState: controller.controller.createChatSessionInputState([]) },
      );
      expect(subDirect.title).toBe('Find shader uniform bug');
      expect(subDirect.history).toHaveLength(2);
      const resp = subDirect.history[1] as { result?: { details?: string } };
      expect(resp.result?.details).toBe('Gemini 4 Neon');

      const subViaQuery = await contentProvider.provideChatSessionContent(
        vscode.Uri.parse(`antigravity:/main-parent-1?subagentChatResource=${encodeURIComponent(`antigravity:/subagent/${subId}`)}`),
        tokenSource.token,
        { inputState: controller.controller.createChatSessionInputState([]) },
      );
      expect(subViaQuery.title).toBe('Find shader uniform bug');
    } finally {
      tokenSource.dispose();
      contentProvider.dispose();
      controller.dispose();
      disposeBackend();
      await fsPromises.rm(tmpBrain, { recursive: true, force: true });
    }
  });

  it('populates ChatResult.details and per-turn __agyTurnStats metadata on live turns', async () => {
    const ws = getMockWorkspace();
    ws.workspaceFolders = [makeWorkspaceFolder('D:\\repo', 'repo')];
    const { backend, disposeBackend } = createFakeBackend([
      { sessionId: 'stats-sess', cwd: 'D:\\repo', title: 'Stats Session' },
    ]);
    const finish = Promise.withResolvers<AcpSessionPromptResult>();
    vi.spyOn(backend, 'prompt').mockReturnValue(finish.promise);
    vi.spyOn(backend, 'waitForConversationFullyIdle').mockResolvedValue();
    let usageCall = 0;
    backend.getSessionContextUsage = vi.fn(async () => {
      usageCall += 1;
      if (usageCall === 1) {
        return {
          estimatedTokensUsed: 1000,
          maxContextTokens: 1048576,
          completionTokens: 100,
          tokenGroups: [],
          modelTotals: [{ model: 'gemini-4-neon', inputTokens: 1000, cachedTokens: 200, outputTokens: 100 }],
        };
      }
      return {
        estimatedTokensUsed: 3500,
        maxContextTokens: 1048576,
        completionTokens: 250,
        tokenGroups: [],
        modelTotals: [{ model: 'gemini-4-neon', inputTokens: 3500, cachedTokens: 800, outputTokens: 250 }],
      };
    });

    const controller = new AgySessionController(backend, createFakeOutputChannel(), nodePath.join(os.tmpdir(), 'nonexistent-convs'));
    await controller.refreshSessions();
    const participant = new AgyChatParticipant(
      backend,
      controller,
      {
        resolveModelAndEffort: () => ({ modelValue: 'gemini-4-neon', thoughtLevel: 'high' }),
        getModelDisplayName: (id: string | undefined) => (id?.includes('gemini-4-neon') ? 'Gemini 4 Neon' : id),
        recordContextWindow: vi.fn(),
      } as unknown as AgyLanguageModelProvider,
      { refresh: vi.fn() } as unknown as QuotaServiceInterface,
      { disposeSession: vi.fn(), isBrowserSubagentCall: () => false } as unknown as BrowserSubagentRenderer,
      createFakeOutputChannel(),
    );

    const resource = buildSessionResource('stats-sess');
    const source = new vscode.CancellationTokenSource();
    const turnPromise = participant.createHandler()(
      { prompt: 'Compute metrics', references: [], toolReferences: [], model: { id: 'gemini-4-neon', name: 'Gemini 4 Neon' } } as unknown as vscode.ChatRequest,
      { history: [], chatSessionContext: { chatSessionItem: { resource, label: 'Stats Session' }, isUntitled: false } },
      { push: vi.fn(), usage: vi.fn() } as unknown as vscode.ChatResponseStream,
      source.token,
    );

    try {
      await vi.waitFor(() => expect(backend.prompt).toHaveBeenCalledOnce());
      finish.resolve({ stopReason: 'end_turn' });
      const result = (await turnPromise) as { details?: string; metadata?: Record<string, unknown> };
      expect(result.details).toBe('Gemini 4 Neon (High)');
      expect(result.metadata?.__agyTurnStats).toMatchObject({
        modelTotals: [{ model: 'Gemini 4 Neon', inputTokens: 2500, cachedTokens: 600, outputTokens: 150 }],
      });
    } finally {
      source.dispose();
      participant.dispose();
      controller.dispose();
      disposeBackend();
    }
  });
});
