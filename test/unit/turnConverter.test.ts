import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockMarkdownString {
    public value: string;
    public isTrusted?: boolean | { readonly enabledCommands: readonly string[] };

    public constructor(value = '') {
      this.value = value;
    }

    public appendMarkdown(value: string): this {
      this.value += value;
      return this;
    }

    public appendText(value: string): this {
      this.value += value;
      return this;
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
      this.query = query;
      this.serialized = serialized;
    }

    public static file(filePath: string): MockUri {
      const normalized = filePath.replace(/\\/g, '/');
      const uriPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
      const serialized = `file://${encodeURI(uriPath)}`;
      return new MockUri('file', '', uriPath, filePath, serialized, '');
    }

    public static parse(raw: string): MockUri {
      if (raw.startsWith('file://')) {
        try {
          const url = new URL(raw);
          const decodedPath = decodeURIComponent(url.pathname);
          const fsPath = /^\/[a-zA-Z]:\//.test(decodedPath) ? decodedPath.slice(1) : decodedPath;
          return new MockUri('file', url.host, decodedPath, fsPath, raw, url.search.replace(/^\?/, ''));
        } catch {
          return new MockUri('file', '', raw.slice('file://'.length), raw.slice('file://'.length), raw, '');
        }
      }
      const colonIdx = raw.indexOf(':');
      const scheme = colonIdx > 0 ? raw.slice(0, colonIdx) : 'file';
      return new MockUri(scheme, '', raw, raw, raw, '');
    }

    public with(change: { query?: string }): MockUri {
      const nextQuery = change.query ?? this.query;
      const base = this.serialized.split('?')[0] ?? this.serialized;
      const nextSerialized = nextQuery.length > 0 ? `${base}?${nextQuery}` : base;
      return new MockUri(this.scheme, this.authority, this.path, this.fsPath, nextSerialized, nextQuery);
    }

    public toString(): string {
      return this.serialized;
    }
  }

  class MockDisposable {
    private readonly callback: () => void;

    public constructor(callOnDispose: () => void) {
      this.callback = callOnDispose;
    }

    public dispose(): void {
      this.callback();
    }
  }

  class MockChatRequestTurn2 {
    public readonly prompt: string;
    public readonly command: string | undefined;
    public readonly references: unknown[];
    public readonly participant: string;
    public readonly toolReferences: readonly unknown[];
    public readonly editedFileEvents?: readonly unknown[] | undefined;
    public readonly id?: string | undefined;
    public readonly modelId?: string | undefined;

    public constructor(
      prompt: string,
      command?: string,
      references: unknown[] = [],
      participant = '',
      toolReferences: readonly unknown[] = [],
      editedFileEvents?: readonly unknown[],
      id?: string,
      modelId?: string,
    ) {
      this.prompt = prompt;
      this.command = command;
      this.references = references;
      this.participant = participant;
      this.toolReferences = toolReferences;
      this.editedFileEvents = editedFileEvents;
      this.id = id;
      this.modelId = modelId;
    }
  }

  class MockChatResponseTurn2 {
    public readonly response: ReadonlyArray<unknown>;
    public readonly result: Record<string, unknown>;
    public readonly participant: string;
    public readonly command: string | undefined;

    public constructor(
      response: ReadonlyArray<unknown>,
      result: Record<string, unknown>,
      participant: string,
      command?: string,
    ) {
      this.response = response;
      this.result = result;
      this.participant = participant;
      this.command = command;
    }
  }

  class MockChatResponseMarkdownPart {
    public value: MockMarkdownString;

    public constructor(value: string | MockMarkdownString) {
      this.value = typeof value === 'string' ? new MockMarkdownString(value) : value;
    }
  }

  class MockChatResponseWarningPart {
    public readonly value: MockMarkdownString;

    public constructor(value: string | MockMarkdownString) {
      this.value = typeof value === 'string' ? new MockMarkdownString(value) : value;
    }
  }

  class MockChatResponseThinkingProgressPart {
    public value: string | string[];
    public id: string | undefined;
    public metadata: Record<string, unknown> | undefined;

    public constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>) {
      this.value = value;
      this.id = id;
      this.metadata = metadata;
    }
  }

  class MockChatSubagentToolInvocationData {
    public description: string;
    public agentName: string;
    public prompt: string;
    public result: string | undefined;
    public modelName: string | undefined;

    public constructor(description: string, agentName: string, prompt: string, result?: string) {
      this.description = description;
      this.agentName = agentName;
      this.prompt = prompt;
      this.result = result;
    }
  }

  class MockChatToolInvocationPart {
    public toolName: string;
    public toolCallId: string;
    public errorMessage: string | undefined;
    public invocationMessage: string | MockMarkdownString | undefined;
    public originMessage: string | MockMarkdownString | undefined;
    public pastTenseMessage: string | MockMarkdownString | undefined;
    public isConfirmed: boolean | undefined;
    public isComplete: boolean | undefined;
    public isError: boolean | undefined;
    public enablePartialUpdate: boolean | undefined;
    public presentation: 'hidden' | 'hiddenAfterComplete' | undefined;
    public subAgentInvocationId: string | undefined;
    public subAgentName: string | undefined;
    public toolSpecificData: unknown;

    public constructor(toolName: string, toolCallId: string, errorMessage?: string) {
      this.toolName = toolName;
      this.toolCallId = toolCallId;
      this.errorMessage = errorMessage;
    }
  }

  class MockChatResponseCommandButtonPart {
    public value: { command: string; title: string; arguments?: unknown[] };

    public constructor(value: { command: string; title: string; arguments?: unknown[] }) {
      this.value = value;
    }
  }

  return {
    ChatRequestTurn2: MockChatRequestTurn2,
    ChatResponseTurn2: MockChatResponseTurn2,
    ChatResponseMarkdownPart: MockChatResponseMarkdownPart,
    ChatResponseWarningPart: MockChatResponseWarningPart,
    ChatResponseCodeblockUriPart: class {
      public constructor(public readonly value: vscode.Uri, public readonly isEdit?: boolean, public readonly undoStopId?: string) {}
    },
    ChatResponseTextEditPart: class {
      public readonly edits: vscode.TextEdit[];
      public readonly isDone: boolean;
      public constructor(public readonly uri: vscode.Uri, edits: vscode.TextEdit | vscode.TextEdit[] | true) {
        this.isDone = edits === true;
        this.edits = edits === true ? [] : Array.isArray(edits) ? edits : [edits];
      }
    },
    ChatResponseAnchorPart: class {
      public constructor(public readonly value: vscode.Uri, public readonly title?: string) {}
    },
    ChatResponseThinkingProgressPart: MockChatResponseThinkingProgressPart,
    ChatToolInvocationPart: MockChatToolInvocationPart,
    ChatSubagentToolInvocationData: MockChatSubagentToolInvocationData,
    ChatResponseCommandButtonPart: MockChatResponseCommandButtonPart,
    MarkdownString: MockMarkdownString,
    Uri: MockUri,
    Disposable: MockDisposable,
    ViewColumn: { Beside: 2, Active: 1 },
    window: {
      createWebviewPanel: (): undefined => undefined,
    },
  };
});

import * as vscode from 'vscode';
import type { AcpSessionUpdate } from '../../src/acp/acpTypes.js';
import { AgyEditTracker } from '../../src/sessions/agyEditTracker.js';
import { BrowserSubagentRenderer, openMediaPreviewPanel } from '../../src/sessions/browserSubagentRenderer.js';
import { LiveStreamAdapter, TurnConverter } from '../../src/sessions/turnConverter.js';

const tempDirs: string[] = [];

async function makeTempBrainDir(): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'agy-brain-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('TurnConverter', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.env.AGY_REPLAY_SAMPLE === undefined)('replays a real session sample without losing response turns', async () => {
    const samplePath = process.env.AGY_REPLAY_SAMPLE;
    if (samplePath === undefined) throw new Error('AGY_REPLAY_SAMPLE is required');
    const updates = JSON.parse(await fs.readFile(samplePath, 'utf8')) as AcpSessionUpdate[];
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const converter = new TurnConverter(renderer, 'sample-replay');
    for (const update of updates) converter.processUpdate(update);
    const result = converter.finalizeHistory();
    const requests = result.turns.filter((turn): turn is vscode.ChatRequestTurn2 => turn instanceof vscode.ChatRequestTurn2);
    const responseCount = result.turns.filter((turn) => turn instanceof vscode.ChatResponseTurn2).length;
    const userChunks = updates.filter((update) => update.sessionUpdate === 'user_message_chunk');
    const inputLength = userChunks.reduce((sum, update) => {
      const content = 'content' in update ? update.content : undefined;
      return sum + (typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string'
        ? content.text.length : 0);
    }, 0);
    expect(updates).toHaveLength(993);
    expect(userChunks).toHaveLength(23);
    expect(requests).toHaveLength(22);
    expect(requests.reduce((sum, request) => sum + request.prompt.length, 0)).toBe(inputLength);
    expect(responseCount).toBeGreaterThan(0);
    expect(result.turns.at(-1)).toBeInstanceOf(vscode.ChatResponseTurn2);
  });

  it('keeps replayed attachments outside the prompt and preserves assistant attachment order', async () => {
    const directory = await makeTempBrainDir();
    const renderer = new BrowserSubagentRenderer(directory);
    const converter = new TurnConverter(renderer, 'session-attachments', undefined, directory);
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
    const image = { type: 'image', data, mimeType: 'image/png' } as const;
    const file = { type: 'resource_link', uri: 'file:///d:/project/report.pdf', name: 'report.pdf' } as const;
    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Inspect' } });
    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: image });
    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: {
      type: 'resource', resource: { uri: 'file:///d:/project/notes.txt#L1-L3', text: 'Selected text' },
    } });
    converter.processUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'See these:' } });
    converter.processUpdate({ sessionUpdate: 'agent_message_chunk', content: image });
    converter.processUpdate({ sessionUpdate: 'agent_message_chunk', content: file });

    const [request, response] = converter.finalizeHistory().turns;
    expect(request).toMatchObject({ prompt: 'Inspect', references: [{ name: 'Image.png' }, { name: 'notes.txt' }] });
    const storedNames = await fs.readdir(directory);
    expect(storedNames).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.png$/)]);
    expect(await Promise.all(storedNames.map((name) => fs.readFile(nodePath.join(directory, name), 'base64')))).toEqual([data]);
    const parts = (response as vscode.ChatResponseTurn2).response;
    expect(parts.map((part) => part.constructor)).toEqual([
      vscode.ChatResponseMarkdownPart, vscode.ChatResponseMarkdownPart, vscode.ChatResponseAnchorPart,
    ]);
    expect((parts[1] as vscode.ChatResponseMarkdownPart).value.value).toContain('![Image.png](file:');
    expect(parts[2]).toMatchObject({ title: 'report.pdf' });

    const push = vi.fn();
    const live = new LiveStreamAdapter(renderer, 'session-live-attachments', { push } as unknown as vscode.ChatResponseStream, () => {}, undefined, directory);
    live.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: image });
    live.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: file });
    expect(push.mock.calls.map(([part]) => part.constructor)).toEqual([
      vscode.ChatResponseMarkdownPart, vscode.ChatResponseAnchorPart,
    ]);
  });

  it('renders the ACP low-credit notice as a native warning after replayed response text', () => {
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const converter = new TurnConverter(renderer, 'session-credit-warning');
    const warning = 'Your AI credits balance is too low to continue.';
    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Run the tests' } });
    converter.processUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Tests started.' } });
    converter.processUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n⚠ ${warning}\n` } });

    const [, responseTurn] = converter.finalizeHistory().turns;
    const parts = (responseTurn as vscode.ChatResponseTurn2).response;
    expect(parts.map((part) => part.constructor)).toEqual([
      vscode.ChatResponseMarkdownPart,
      vscode.ChatResponseWarningPart,
    ]);
    expect(parts).toMatchObject([{ value: { value: 'Tests started.' } }, { value: { value: warning } }]);
  });

  it('streams the low-credit warning without restyling quoted or unrelated text', () => {
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const push = vi.fn<(part: vscode.ChatResponsePart) => void>();
    const stream = { push } as unknown as vscode.ChatResponseStream;
    const live = new LiveStreamAdapter(renderer, 'session-live-credit-warning', stream, () => {});
    const warning = 'Your AI credits balance is too low to continue.';
    const quoted = `> ⚠ ${warning}`;
    const unrelated = '⚠ Review the test output.';

    for (const text of [quoted, unrelated, `\n⚠\uFE0F ${warning}\n`]) {
      live.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    }

    const parts = push.mock.calls.map(([part]) => part);
    expect(parts.map((part) => part.constructor)).toEqual([
      vscode.ChatResponseMarkdownPart,
      vscode.ChatResponseMarkdownPart,
      vscode.ChatResponseWarningPart,
    ]);
    expect(parts).toMatchObject([{ value: { value: quoted } }, { value: { value: unrelated } }, { value: { value: warning } }]);
  });

  it('converts user prompt, thinking, markdown, plan, run_command, read_file, and write_file updates', () => {
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const converter = new TurnConverter(renderer, 'session-1', 'antigravity');

    converter.processUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Inspect config ' },
    });
    converter.processUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'and run tests\nDetails here' },
    });

    converter.processUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Let me read the file ' },
    });
    converter.processUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'and run vitest.' },
    });

    converter.processUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read tsconfig.json', status: 'completed' },
        { content: 'Run tests', status: 'in_progress' },
        { content: 'Update config', status: 'pending' },
      ],
    });

    converter.processUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-read-1',
      name: 'read_file',
      kind: 'read',
      status: 'in_progress',
      args: { Path: 'D:\\repo\\tsconfig.json', StartLine: 10, EndLine: 25 },
    });
    converter.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-read-1',
      status: 'completed',
    });

    converter.processUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-cmd-1',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      args: { CommandLine: 'npx vitest run' },
    });
    converter.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-cmd-1',
      status: 'completed',
      rawOutput: { output: '12 passed', exitCode: 0, duration: 350 },
    });

    converter.processUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-write-1',
      name: 'write_file',
      kind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: 'D:\\repo\\src\\app.ts',
          oldText: 'const a = 1;\nconst b = 2;\n',
          newText: 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
        },
      ],
    });

    converter.processUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All ' },
    });
    converter.processUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done!' },
    });

    const history = converter.finalizeHistory();
    expect(history.title).toBe('Inspect config and run tests');
    expect(history.turns).toHaveLength(2);

    const requestTurn = history.turns[0];
    expect(requestTurn).toBeInstanceOf(vscode.ChatRequestTurn2);
    if (requestTurn instanceof vscode.ChatRequestTurn2) {
      expect(requestTurn.prompt).toBe('Inspect config and run tests\nDetails here');
      expect(requestTurn.participant).toBe('antigravity');
    }

    const responseTurn = history.turns[1];
    expect(responseTurn).toBeInstanceOf(vscode.ChatResponseTurn2);
    if (responseTurn instanceof vscode.ChatResponseTurn2) {
      expect(responseTurn.participant).toBe('antigravity');
      const parts = responseTurn.response;
      expect(parts).toHaveLength(6);

      const thoughtPart = parts[0];
      expect(thoughtPart).toBeInstanceOf(vscode.ChatResponseThinkingProgressPart);
      if (thoughtPart instanceof vscode.ChatResponseThinkingProgressPart) {
        expect(thoughtPart.value).toBe('Let me read the file and run vitest.');
      }

      const planPart = parts[1];
      expect(planPart).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (planPart instanceof vscode.ChatToolInvocationPart) {
        expect(planPart.toolSpecificData).toEqual({
          todoList: [
            { id: 1, title: 'Read tsconfig.json', status: 3 },
            { id: 2, title: 'Run tests', status: 2 },
            { id: 3, title: 'Update config', status: 1 },
          ],
        });
      }

      const readPart = parts[2];
      expect(readPart).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (readPart instanceof vscode.ChatToolInvocationPart) {
        expect(readPart.isComplete).toBe(true);
        expect(readPart.isConfirmed).toBe(true);
        expect(readPart.invocationMessage).toBeInstanceOf(vscode.MarkdownString);
        const msg = readPart.invocationMessage as vscode.MarkdownString;
        expect(msg.value).toMatch(/Reading \[\]\(file:.*tsconfig\.json#10-10\), lines 10 to 25/);
        expect(readPart.toolSpecificData).toBeUndefined();
      }

      const cmdPart = parts[3];
      expect(cmdPart).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (cmdPart instanceof vscode.ChatToolInvocationPart) {
        expect(cmdPart.isComplete).toBe(true);
        expect(cmdPart.isError).toBe(false);
        expect(cmdPart.pastTenseMessage).toBeUndefined();
        expect(cmdPart.toolSpecificData).toEqual({
          commandLine: { original: 'npx vitest run' },
          language: 'pwsh',
          output: { text: '12 passed' },
          state: { exitCode: 0, duration: 350 },
        });
      }

      const writePart = parts[4];
      expect(writePart).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (writePart instanceof vscode.ChatToolInvocationPart) {
        expect(writePart.isComplete).toBe(true);
        expect(writePart.presentation).toBeUndefined();
        expect(writePart.invocationMessage).toBeInstanceOf(vscode.MarkdownString);
        expect((writePart.invocationMessage as vscode.MarkdownString).value).toContain('Write [app.ts (+2 -1)]');
      }

      const mdPart = parts[5];
      expect(mdPart).toBeInstanceOf(vscode.ChatResponseMarkdownPart);
      if (mdPart instanceof vscode.ChatResponseMarkdownPart) {
        expect(mdPart.value.value).toBe('All done!');
      }
    }

    expect(history.changes).toHaveLength(1);
    expect(history.changes[0]?.insertions).toBe(2);
    expect(history.changes[0]?.deletions).toBe(1);
    expect(history.changes[0]?.modifiedUri.fsPath).toContain('app.ts');
    expect(history.changes[0]?.uri.toString()).toBe(history.changes[0]?.modifiedUri.toString());
  });

  it('keeps replayed multi-file edits as a clean tool invocation without +0 -0 pills and preserves original URIs', () => {
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const converter = new TurnConverter(renderer, 'multi-edit');
    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Edit files' } });
    converter.processUpdate({ sessionUpdate: 'tool_call', toolCallId: 'multi', name: 'edit_file', kind: 'edit',
      status: 'completed', content: [
        { type: 'diff', path: 'D:\\repo\\empty.txt', oldText: '', newText: 'new' },
        { type: 'diff', path: 'D:\\repo\\created.txt', newText: 'created' },
      ] });
    const result = converter.finalizeHistory();
    const response = result.turns[1] as vscode.ChatResponseTurn2;
    expect(response.response).toHaveLength(1);
    expect(response.response[0]).toBeInstanceOf(vscode.ChatToolInvocationPart);
    expect(response.response[0]).toMatchObject({ presentation: undefined });
    expect(result.changes[0]?.originalUri?.toString()).toBe(result.changes[0]?.uri.toString());
    expect(result.changes[1]?.originalUri).toBeUndefined();
  });

  it('keeps failed edit tools visible and does not report them as file changes', () => {
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const converter = new TurnConverter(renderer, 'failed-edit');
    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Edit' } });
    converter.processUpdate({ sessionUpdate: 'tool_call', toolCallId: 'failed', name: 'write_file', kind: 'edit',
      status: 'failed', args: { Path: 'D:\\repo\\failed.txt', Content: 'not written' } });
    const result = converter.finalizeHistory();
    const response = result.turns[1] as vscode.ChatResponseTurn2;
    expect(response.response).toHaveLength(1);
    expect(response.response[0]).toMatchObject({ isError: true, presentation: undefined });
    expect(result.changes).toEqual([]);
  });

  it('streams terminal progress and failure output without a duplicate command description', () => {
    const renderer = new BrowserSubagentRenderer(nodePath.join(os.tmpdir(), 'non-existent-brain'));
    const push = vi.fn<(part: vscode.ChatToolInvocationPart) => void>();
    const stream = { push } as unknown as vscode.ChatResponseStream;
    const adapter = new LiveStreamAdapter(renderer, 'session-live-terminal', stream, () => {});
    const command = 'Get-ChildItem -Force missing-folder';

    adapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'live-terminal-1',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      args: { CommandLine: command },
    });

    const runningPart = push.mock.lastCall?.[0];
    expect(runningPart).toMatchObject({
      isComplete: false,
      invocationMessage: `Run \`${command}\``,
      toolSpecificData: { commandLine: { original: command } },
    });
    expect(runningPart?.pastTenseMessage).toBeUndefined();

    adapter.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'live-terminal-1',
      status: 'failed',
      rawOutput: { stderr: 'Cannot find path', exitCode: 1, duration: 25 },
    });

    const completedPart = push.mock.lastCall?.[0];
    expect(completedPart).toMatchObject({
      isComplete: true,
      isError: true,
      toolSpecificData: {
        commandLine: { original: command },
        output: { text: 'Cannot find path' },
        state: { exitCode: 1, duration: 25 },
      },
    });
    expect(completedPart?.pastTenseMessage).toBeUndefined();
  });

  it('replays browser invoke_subagent with ChatSubagentToolInvocationData, nested steps, Uint8Array images, and WebM button', async () => {
    const brainRoot = await makeTempBrainDir();
    const sessionId = 'session-browser-replay';
    const sessionDir = nodePath.join(brainRoot, sessionId);
    const logsDir = nodePath.join(sessionDir, '.system_generated', 'logs');
    await fs.mkdir(logsDir, { recursive: true });

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00]);
    const pngPath = nodePath.join(sessionDir, 'step1.png');
    const webpPath = nodePath.join(sessionDir, 'step2.webp');
    const webmPath = nodePath.join(sessionDir, 'recording.webm');

    await fs.writeFile(pngPath, pngBytes);
    await fs.writeFile(webpPath, webpBytes);
    await fs.writeFile(webmPath, Buffer.from('WEBM_DATA'));

    const transcriptLines = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Navigating to example.com',
        tool_calls: [{ id: 'b1', name: 'browser_navigate', arguments: { url: 'https://example.com' } }],
        media: [{ mime_type: 'image/png', uri: pngPath }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Clicking login button',
        tool_calls: [{ id: 'b2', name: 'click', arguments: { selector: '#login-btn' } }],
        media: [{ mime_type: 'image/webp', uri: webpPath }],
      }),
    ];
    await fs.writeFile(nodePath.join(logsDir, 'transcript.jsonl'), `${transcriptLines.join('\n')}\n`, 'utf8');

    const renderer = new BrowserSubagentRenderer(brainRoot);
    const converter = new TurnConverter(renderer, sessionId);

    converter.processUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Open example.com and click login' },
    });
    converter.processUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'sub-browser-1',
      name: 'invoke_subagent',
      status: 'in_progress',
      args: {
        TypeName: 'browser',
        Role: 'Web Login Checker',
        Prompt: 'Open https://example.com and click #login-btn',
      },
    });
    converter.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'sub-browser-1',
      status: 'completed',
      rawOutput: { text: 'Clicked login button successfully.' },
    });

    const history = converter.finalizeHistory();
    expect(history.turns).toHaveLength(2);
    const responseTurn = history.turns[1];
    expect(responseTurn).toBeInstanceOf(vscode.ChatResponseTurn2);

    if (responseTurn instanceof vscode.ChatResponseTurn2) {
      const parts = responseTurn.response;
      expect(parts).toHaveLength(4);

      const parentPart = parts[0];
      expect(parentPart).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (parentPart instanceof vscode.ChatToolInvocationPart) {
        expect(parentPart.toolName).toBe('browser');
        expect(parentPart.toolCallId).toBe('sub-browser-1');
        expect(parentPart.isComplete).toBe(true);
        expect(parentPart.toolSpecificData).toBeInstanceOf(vscode.ChatSubagentToolInvocationData);
        const subagentData = parentPart.toolSpecificData as vscode.ChatSubagentToolInvocationData;
        expect(subagentData.description).toBe('Web Login Checker');
        expect(subagentData.agentName).toBe('Browser');
        expect(subagentData.prompt).toBe('Open https://example.com and click #login-btn');
        expect(subagentData.result).toBe('Clicked login button successfully.');
      }

      const child1 = parts[1];
      expect(child1).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (child1 instanceof vscode.ChatToolInvocationPart) {
        expect(child1.subAgentInvocationId).toBe('sub-browser-1');
        expect(child1.subAgentName).toBe('Browser');
        expect(child1.toolName).toBe('browser_navigate');
        const embedData = child1.toolSpecificData as vscode.ChatEmbedToolResultData;
        expect(embedData.output).toHaveLength(1);
        expect(embedData.output[0]?.mimeType).toBe('image/png');
        expect(embedData.output[0]?.data).toBeInstanceOf(Uint8Array);
        expect(Array.from(embedData.output[0]?.data ?? [])).toEqual(Array.from(pngBytes));
      }

      const child2 = parts[2];
      expect(child2).toBeInstanceOf(vscode.ChatToolInvocationPart);
      if (child2 instanceof vscode.ChatToolInvocationPart) {
        expect(child2.subAgentInvocationId).toBe('sub-browser-1');
        expect(child2.subAgentName).toBe('Browser');
        expect(child2.toolName).toBe('click');
        const embedData = child2.toolSpecificData as vscode.ChatEmbedToolResultData;
        expect(embedData.output).toHaveLength(1);
        expect(embedData.output[0]?.mimeType).toBe('image/webp');
        expect(embedData.output[0]?.data).toBeInstanceOf(Uint8Array);
        expect(Array.from(embedData.output[0]?.data ?? [])).toEqual(Array.from(webpBytes));
      }

      const videoBtn = parts[3];
      expect(videoBtn).toBeInstanceOf(vscode.ChatResponseCommandButtonPart);
      if (videoBtn instanceof vscode.ChatResponseCommandButtonPart) {
        expect(videoBtn.value.command).toBe('antigravityHarness.openMediaPreview');
        expect(videoBtn.value.arguments).toEqual([webmPath, 'Web Login Checker']);
      }
    }
  });

  it('streams live browser trajectory steps, detects CAPTCHA needs-input, embeds media, and emits WebM button on completion', async () => {
    const brainRoot = await makeTempBrainDir();
    const sessionId = 'session-live-browser';
    const subagentDir = nodePath.join(brainRoot, 'subagent-conv-99');
    const logsDir = nodePath.join(subagentDir, '.system_generated', 'logs');
    await fs.mkdir(logsDir, { recursive: true });

    const pushedParts: unknown[] = [];
    const mockStream: vscode.ChatResponseStream = {
      markdown: vi.fn(),
      anchor: vi.fn(),
      button: vi.fn(),
      filetree: vi.fn(),
      progress: vi.fn(),
      reference: vi.fn(),
      questionCarousel: vi.fn(async () => undefined),
      externalEdit: vi.fn(async (_uri, callback) => { await callback(); return 'undo'; }),
      usage: vi.fn(),
      push: (part: vscode.ChatResponsePart) => {
        pushedParts.push(part);
      },
    };
    const fileChanges: vscode.ChatSessionFileChange[] = [];
    const needsInputReasons: string[] = [];

    const renderer = new BrowserSubagentRenderer(brainRoot);
    const liveAdapter = new LiveStreamAdapter(
      renderer,
      sessionId,
      mockStream,
      (change) => {
        fileChanges.push(change);
      },
      (reason) => {
        needsInputReasons.push(reason);
      },
    );

    liveAdapter.handleUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Starting browser...' },
    });

    liveAdapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'live-edit-1',
      name: 'write_file',
      kind: 'edit',
      status: 'completed',
      args: { Path: 'D:\\repo\\notes.txt', Content: 'line 1\nline 2\n' },
    });
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0]?.insertions).toBe(2);

    liveAdapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'live-browser-1',
      name: 'invoke_subagent',
      status: 'in_progress',
      rawInput: {
        TypeName: 'browser',
        Role: 'Checkout Runner',
        Prompt: 'Navigate to checkout portal',
      },
    });

    const initialParent = pushedParts.find(
      (p): p is vscode.ChatToolInvocationPart =>
        p instanceof vscode.ChatToolInvocationPart && p.toolCallId === 'live-browser-1',
    );
    expect(initialParent).toBeDefined();
    expect(initialParent?.enablePartialUpdate).toBe(true);
    expect(initialParent?.isComplete).toBe(false);

    const pngPath = nodePath.join(subagentDir, 'checkout.png');
    const webmPath = nodePath.join(subagentDir, 'checkout.webm');
    await fs.writeFile(pngPath, new Uint8Array([1, 2, 3, 4]));
    await fs.writeFile(webmPath, Buffer.from('VIDEO'));

    const transcriptPath = nodePath.join(logsDir, 'transcript.jsonl');
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        step_index: 1,
        content: 'Paused: Cloudflare Turnstile verify you are human challenge detected',
        tool_calls: [{ id: 'step-nav', name: 'browser_navigate', arguments: { url: 'https://shop.example.com' } }],
        media: [{ mime_type: 'image/png', uri: pngPath }],
      })}\n`,
      'utf8',
    );

    await vi.waitFor(
      () => {
        expect(needsInputReasons.length).toBeGreaterThan(0);
        const childParts = pushedParts.filter(
          (p) => p instanceof vscode.ChatToolInvocationPart && p.subAgentInvocationId === 'live-browser-1',
        );
        expect(childParts.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    liveAdapter.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'live-browser-1',
      status: 'completed',
      rawOutput: { text: 'Completed after user verification.' },
    });
    liveAdapter.flush();

    const parentUpdates = pushedParts.filter(
      (p): p is vscode.ChatToolInvocationPart =>
        p instanceof vscode.ChatToolInvocationPart && p.toolCallId === 'live-browser-1',
    );
    expect(parentUpdates.length).toBeGreaterThanOrEqual(2);

    const lastParent = parentUpdates[parentUpdates.length - 1];
    expect(lastParent?.isComplete).toBe(true);
    expect((lastParent?.toolSpecificData as vscode.ChatSubagentToolInvocationData).result).toBe(
      'Completed after user verification.',
    );

    const webmButton = pushedParts.find(
      (p): p is vscode.ChatResponseCommandButtonPart => p instanceof vscode.ChatResponseCommandButtonPart,
    );
    expect(webmButton).toBeDefined();
    expect(webmButton?.value.command).toBe('antigravityHarness.openMediaPreview');
    expect(webmButton?.value.arguments).toEqual([webmPath, 'Checkout Runner']);
  });

  it('opens WebviewPanel safely for .webm and .png media previews', () => {
    const fakePanel = {
      webview: {
        cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
        asWebviewUri: (uri: vscode.Uri): vscode.Uri => uri,
        html: '',
      },
    };
    const createPanelSpy = vi
      .spyOn(vscode.window, 'createWebviewPanel')
      .mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    openMediaPreviewPanel('D:\\temp\\recording.webm', 'Session <Video>');
    expect(createPanelSpy).toHaveBeenCalledTimes(1);
    expect(fakePanel.webview.html).toContain('<video controls autoplay loop playsinline');
    expect(fakePanel.webview.html).toContain('Session &lt;Video&gt;');

    openMediaPreviewPanel('D:\\temp\\shot.png');
    expect(createPanelSpy).toHaveBeenCalledTimes(2);
    expect(fakePanel.webview.html).toContain('<img src=');
  });

  it('forwards valid usage_update events to stream.usage and onUsageUpdate in LiveStreamAdapter', () => {
    const renderer = new BrowserSubagentRenderer('D:\\unused');
    const usage = vi.fn();
    const onUsageUpdate = vi.fn();
    const adapter = new LiveStreamAdapter(
      renderer,
      'session-live-usage',
      { push: vi.fn(), usage } as unknown as vscode.ChatResponseStream,
      () => {},
      undefined,
      undefined,
      onUsageUpdate,
    );

    adapter.handleUpdate({ sessionUpdate: 'usage_update', used: 12_345, size: 200_000 });
    adapter.handleUpdate({ sessionUpdate: 'usage_update', used: -1, size: 200_000 });
    adapter.handleUpdate({ sessionUpdate: 'usage_update', used: Number.NaN, size: 200_000 });

    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({ promptTokens: 12_345, completionTokens: 0 });
    expect(onUsageUpdate).toHaveBeenCalledTimes(1);
    expect(onUsageUpdate).toHaveBeenCalledWith({ sessionUpdate: 'usage_update', used: 12_345, size: 200_000 });
  });

  it('captures usage_update and loaded modelId in TurnConverter.finalizeHistory', () => {
    const renderer = new BrowserSubagentRenderer('D:\\unused');
    const converter = new TurnConverter(renderer, 'session-replay-usage');

    converter.processUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Inspect files' } });
    converter.processUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    converter.processUpdate({ sessionUpdate: 'usage_update', used: 34_500, size: 1_048_576 });

    const history = converter.finalizeHistory('antigravity/gemini-pro');
    expect(history.usage).toEqual({ used: 34_500, size: 1_048_576 });
    expect(history.turns).toHaveLength(2);
    expect((history.turns[0] as vscode.ChatRequestTurn2).modelId).toBe('antigravity/gemini-pro');
    const responseTurn = history.turns[1] as vscode.ChatResponseTurn2;
    const lastPart = responseTurn.response[responseTurn.response.length - 1] as vscode.ChatResponseMarkdownPart;
    expect(lastPart.value.value).toBe('<!--AGY_USAGE:{"used":34500,"size":1048576}-->');
  });

  it('hides workspace live edits from the initial in_progress update and keeps brain artifacts as single tool steps', async () => {
    const renderer = new BrowserSubagentRenderer('D:\\unused');
    const pushed: unknown[] = [];
    const changes: vscode.ChatSessionFileChange[] = [];
    const externalEdits: vscode.Uri[] = [];
    const workspaceRoot = await makeTempBrainDir();
    const editTracker = new AgyEditTracker({
      sessionId: 'session-live-edit-pill',
      sessionCwd: workspaceRoot,
      workspaceFolderPaths: [workspaceRoot],
      startExternalEdit: async (uri, write, onTracked) => {
        externalEdits.push(uri);
        await write();
        onTracked();
      },
    });
    const adapter = new LiveStreamAdapter(
      renderer,
      'session-live-edit-pill',
      {
        push: (part: unknown) => {
          pushed.push(part);
        },
      } as unknown as vscode.ChatResponseStream,
      (change) => {
        changes.push(change);
      },
      undefined,
      undefined,
      undefined,
      editTracker,
    );

    const workspaceFile = nodePath.join(workspaceRoot, 'src', 'app.ts');
    await fs.mkdir(nodePath.dirname(workspaceFile), { recursive: true });
    await fs.writeFile(workspaceFile, 'b\nc', 'utf8');

    adapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      kind: 'edit',
      name: 'replace_file_content',
      status: 'in_progress',
      rawInput: { TargetFile: workspaceFile },
    });
    expect(pushed).toHaveLength(1);
    expect((pushed[0] as vscode.ChatToolInvocationPart).presentation).toBe('hidden');

    adapter.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      rawInput: { TargetFile: workspaceFile, TargetContent: 'a', ReplacementContent: 'b\nc' },
    });
    await editTracker.flush();

    expect((pushed[0] as vscode.ChatToolInvocationPart).presentation).toBe('hidden');
    expect(pushed.some((part) => part instanceof vscode.ChatResponseTextEditPart)).toBe(false);
    expect(changes).toHaveLength(1);
    expect(externalEdits).toHaveLength(1);

    const pushedBrain: unknown[] = [];
    const brainChanges: vscode.ChatSessionFileChange[] = [];
    const brainAdapter = new LiveStreamAdapter(
      renderer,
      'session-brain-edit',
      {
        push: (part: unknown) => {
          pushedBrain.push(part);
        },
      } as unknown as vscode.ChatResponseStream,
      (change) => {
        brainChanges.push(change);
      },
      undefined,
      undefined,
      undefined,
      editTracker,
    );
    const brainPlanPath = nodePath.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'conv-1', 'implementation_plan.md');
    brainAdapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'brain-write-1',
      kind: 'edit',
      name: 'write_file',
      status: 'completed',
      rawInput: { TargetFile: brainPlanPath, CodeContent: 'line 1\nline 2\n' },
    });

    expect(pushedBrain).toHaveLength(1);
    const brainPart = pushedBrain[0] as vscode.ChatToolInvocationPart;
    expect(brainPart.presentation).toBeUndefined();
    expect((brainPart.pastTenseMessage as { value?: string } | undefined)?.value).toContain('Write [implementation_plan.md (+2 -0)]');
    expect(brainChanges).toHaveLength(0);
  });

  it('displays skill name with vscodeLinkType=skill when reading SKILL.md', async () => {
    const tmpRoot = await makeTempBrainDir();
    const skillDir = nodePath.join(tmpRoot, 'skills', 'antigravity_guide');
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = nodePath.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, '---\nname: antigravity-guide\ndescription: Test skill\n---\n# Guide\n', 'utf8');

    const fallbackDir = nodePath.join(tmpRoot, 'skills', 'custom-dir-skill');
    await fs.mkdir(fallbackDir, { recursive: true });
    const fallbackPath = nodePath.join(fallbackDir, 'SKILL.md');
    await fs.writeFile(fallbackPath, '# No Frontmatter\n', 'utf8');

    const renderer = new BrowserSubagentRenderer(tmpRoot);
    const pushed: unknown[] = [];
    const adapter = new LiveStreamAdapter(
      renderer,
      'session-skill-read',
      {
        push: (part: unknown) => {
          pushed.push(part);
        },
      } as unknown as vscode.ChatResponseStream,
      vi.fn(),
    );

    adapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'read-skill-1',
      kind: 'read',
      name: 'read_file',
      status: 'in_progress',
      rawInput: { AbsolutePath: skillPath, StartLine: 1, EndLine: 25 },
    });
    const part = pushed[0] as vscode.ChatToolInvocationPart;
    expect((part.invocationMessage as { value: string }).value).toContain('Reading skill [antigravity-guide](');
    expect((part.invocationMessage as { value: string }).value).toContain('SKILL.md?vscodeLinkType=skill#1-1), lines 1 to 25');

    adapter.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-skill-1',
      status: 'completed',
    });
    expect((part.pastTenseMessage as { value: string }).value).toContain('Read skill [antigravity-guide](');

    adapter.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'read-skill-2',
      kind: 'read',
      name: 'read_file',
      status: 'completed',
      rawInput: { AbsolutePath: fallbackPath },
    });
    const fallbackPart = pushed[2] as vscode.ChatToolInvocationPart;
    expect((fallbackPart.pastTenseMessage as { value: string }).value).toContain('Read skill [custom-dir-skill](');
  });
});
