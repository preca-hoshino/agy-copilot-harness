import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockUri {
    public readonly scheme: string;
    public readonly path: string;
    public readonly fsPath: string;
    public readonly query: string;

    public constructor(scheme: string, uriPath: string, fsPath: string, query = '') {
      this.scheme = scheme;
      this.path = uriPath;
      this.fsPath = fsPath;
      this.query = query;
    }

    public static file(fsPath: string): MockUri {
      const normalized = fsPath.replace(/\\/g, '/');
      const uriPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
      return new MockUri('file', uriPath, fsPath, '');
    }

    public static parse(raw: string): MockUri {
      const url = new URL(raw);
      return new MockUri(url.protocol.replace(':', ''), url.pathname, url.pathname, url.search.replace(/^\?/, ''));
    }

    public with(change: { query?: string }): MockUri {
      return new MockUri(this.scheme, this.path, this.fsPath, change.query ?? this.query);
    }

    public toString(): string {
      const q = this.query.length > 0 ? `?${this.query}` : '';
      return `${this.scheme}://${this.path}${q}`;
    }
  }

  return {
    Uri: MockUri,
    workspace: {
      workspaceFolders: [],
    },
  };
});

import {
  AgyEditTracker,
  isInternalAntigravityPath,
  isWorkspaceTrackedPath,
  reconstructBeforeContent,
  stripAgyBeforeQuery,
} from '../../src/sessions/agyEditTracker.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'agy-edit-tracker-'));
  tempDirs.push(dir);
  return dir;
}

describe('agyEditTracker', () => {
  it('classifies internal Antigravity brain artifacts separately from workspace files', () => {
    const brainPlan = nodePath.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'abc', 'implementation_plan.md');
    expect(isInternalAntigravityPath(brainPlan)).toBe(true);
    expect(isWorkspaceTrackedPath(brainPlan, nodePath.dirname(brainPlan), [nodePath.dirname(brainPlan)])).toBe(false);

    const workspaceFile = nodePath.join('D:\\repo', 'src', 'index.ts');
    expect(isInternalAntigravityPath(workspaceFile)).toBe(false);
    expect(isWorkspaceTrackedPath(workspaceFile, 'D:\\repo', [])).toBe(true);
    expect(isWorkspaceTrackedPath('C:\\outside\\file.ts', 'D:\\repo', [])).toBe(false);
  });

  it('reconstructs pre-edit content from replace_file_content, multi_replace, and diff payloads', () => {
    expect(
      reconstructBeforeContent('const x = 2;\n', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        name: 'replace_file_content',
        rawInput: { TargetContent: 'const x = 1;', ReplacementContent: 'const x = 2;' },
      }),
    ).toBe('const x = 1;\n');

    expect(
      reconstructBeforeContent('alpha();\nbeta2();\ngamma2();\n', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't2',
        name: 'multi_replace_file_content',
        rawInput: {
          ReplacementChunks: [
            { TargetContent: 'beta();', ReplacementContent: 'beta2();' },
            { TargetContent: 'gamma();', ReplacementContent: 'gamma2();' },
          ],
        },
      }),
    ).toBe('alpha();\nbeta();\ngamma();\n');

    expect(
      reconstructBeforeContent('new body', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't3',
        name: 'write_file',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'old body', newText: 'new body' }],
      }),
    ).toBe('old body');
  });

  it('captures baseline snapshot URI with __agy_before for workspace edits and skips brain files', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const targetFile = nodePath.join(workspaceRoot, 'src', 'hello.ts');
    await fs.mkdir(nodePath.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, 'export const a = 2;\n', 'utf8');

    const trackedCalls: Array<{ uri: string; cleanUri: string; baselineText: string }> = [];
    const tracker = new AgyEditTracker({
      sessionId: 'sess-1',
      sessionCwd: workspaceRoot,
      workspaceFolderPaths: [workspaceRoot],
      startExternalEdit: async (uri, write, onTracked) => {
        const cleanUri = stripAgyBeforeQuery(uri);
        const match = /__agy_before=([^&]+)/.exec(uri.query);
        const baselineUri = match?.[1] !== undefined ? decodeURIComponent(match[1]) : '';
        const baselinePath = baselineUri.replace(/^file:\/\//, '').replace(/^\/([a-zA-Z]:\/)/, '$1');
        const baselineText = baselinePath.length > 0 ? await fs.readFile(baselinePath, 'utf8') : '';
        trackedCalls.push({ uri: uri.toString(), cleanUri: cleanUri.toString(), baselineText });
        await write();
        onTracked();
      },
    });

    tracker.handleToolCallUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'w1',
      kind: 'edit',
      name: 'replace_file_content',
      status: 'completed',
      rawInput: { TargetFile: targetFile, TargetContent: 'export const a = 1;', ReplacementContent: 'export const a = 2;' },
    });

    const brainFile = nodePath.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'sess-1', 'task.md');
    tracker.handleToolCallUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'w2',
      kind: 'edit',
      name: 'write_file',
      status: 'completed',
      rawInput: { TargetFile: brainFile, CodeContent: '# Task' },
    });

    await tracker.flush();
    expect(trackedCalls).toHaveLength(1);
    expect(trackedCalls[0]?.baselineText).toBe('export const a = 1;\n');
    expect(trackedCalls[0]?.cleanUri).not.toContain('__agy_before');
  });
});
