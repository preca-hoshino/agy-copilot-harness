import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class CancellationTokenSource {
    private cancelled = false;
    private readonly listeners = new Set<() => void>();
    public readonly token = {
      get isCancellationRequested(): boolean { return false; },
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
      },
    };
    public constructor() {
      const source = this;
      Object.defineProperty(this.token, 'isCancellationRequested', { get: () => source.cancelled });
    }
    public cancel(): void {
      if (!this.cancelled) {
        this.cancelled = true;
        for (const listener of this.listeners) listener();
      }
    }
    public dispose(): void { this.listeners.clear(); }
  }
  return {
    CancellationTokenSource,
    ChatResponseMarkdownPart: class {
      public constructor(public readonly value: string) {}
    },
    ChatResponseCodeblockUriPart: class {
      public constructor(public readonly value: unknown, public readonly isEdit: boolean, public readonly undoStopId?: string) {}
    },
    ChatResponseTextEditPart: class {
      public constructor(public readonly uri: unknown, public readonly edits: unknown) {}
    },
  };
});

import * as vscode from 'vscode';
import { ActiveAgyTurn } from '../../src/sessions/activeAgyTurn.js';

const uri = { toString: () => 'file:///test.txt' } as vscode.Uri;

describe('ActiveAgyTurn external edits', () => {
  it('wraps one write and replays only inert display parts after reconnect', async () => {
    const events: string[] = [];
    const stream = {
      push: vi.fn(),
      externalEdit: vi.fn(async (_uri: vscode.Uri, callback: () => Promise<void>) => {
        events.push('snapshot');
        await callback();
        events.push('stop');
        return 'undo-1';
      }),
    } as unknown as vscode.ChatResponseStream;
    const turn = new ActiveAgyTurn([], stream, () => {});
    const write = vi.fn(async () => { events.push('write'); });
    const tracked = vi.fn();
    const reopened = { push: vi.fn(), externalEdit: vi.fn() } as unknown as vscode.ChatResponseStream;
    const source = new vscode.CancellationTokenSource();
    await turn.externalEdit(uri, write, tracked);
    const attached = turn.attach(reopened, source.token);
    expect(events).toEqual(['snapshot', 'write', 'stop']);
    expect(write).toHaveBeenCalledOnce();
    expect(tracked).toHaveBeenCalledOnce();
    expect(reopened.push).toHaveBeenCalledTimes(5);
    expect(reopened.externalEdit).not.toHaveBeenCalled();
    expect(reopened.push).toHaveBeenNthCalledWith(2, expect.objectContaining({ isEdit: true, undoStopId: 'undo-1' }));
    turn.finish();
    await attached;
    source.dispose();
  });

  it.each(['before', 'after', 'twice'] as const)('never duplicates writes when the UI fails or invokes the callback %s', async (scenario) => {
    const stream = {
      push: vi.fn(),
      externalEdit: vi.fn(async (_uri: vscode.Uri, callback: () => Promise<void>) => {
        if (scenario === 'before') throw new Error('start failed');
        await callback();
        if (scenario === 'twice') await callback();
        if (scenario === 'after') throw new Error('stop failed');
        return 'undo-2';
      }),
    } as unknown as vscode.ChatResponseStream;
    const turn = new ActiveAgyTurn([], stream, () => {});
    const write = vi.fn(async () => {});
    const tracked = vi.fn();
    await turn.externalEdit(uri, write, tracked);
    expect(write).toHaveBeenCalledOnce();
    expect(tracked).toHaveBeenCalledTimes(scenario === 'twice' ? 1 : 0);
    turn.finish();
  });

  it('propagates a failed write without attempting it again', async () => {
    const stream = {
      push: vi.fn(),
      externalEdit: vi.fn(async (_uri: vscode.Uri, callback: () => Promise<void>) => {
        await callback();
        return 'undo';
      }),
    } as unknown as vscode.ChatResponseStream;
    const turn = new ActiveAgyTurn([], stream, () => {});
    const write = vi.fn(async () => { throw new Error('disk failure'); });
    await expect(turn.externalEdit(uri, write, vi.fn())).rejects.toThrow('disk failure');
    expect(write).toHaveBeenCalledOnce();
    turn.finish();
  });

  it('forwards token usage updates and replays the latest usage on attach', async () => {
    const stream = {
      push: vi.fn(),
      usage: vi.fn(),
    } as unknown as vscode.ChatResponseStream;
    const turn = new ActiveAgyTurn([], stream, () => {});
    turn.usage({ promptTokens: 1200, completionTokens: 0 });
    turn.usage({ promptTokens: 4500, completionTokens: 0 });
    expect(stream.usage).toHaveBeenCalledTimes(2);
    expect(stream.usage).toHaveBeenLastCalledWith({ promptTokens: 4500, completionTokens: 0 });

    const reopened = { push: vi.fn(), usage: vi.fn() } as unknown as vscode.ChatResponseStream;
    const source = new vscode.CancellationTokenSource();
    const attached = turn.attach(reopened, source.token);
    expect(reopened.usage).toHaveBeenCalledOnce();
    expect(reopened.usage).toHaveBeenCalledWith({ promptTokens: 4500, completionTokens: 0 });

    turn.finish();
    await attached;
    source.dispose();
  });
});