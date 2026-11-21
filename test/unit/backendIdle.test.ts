import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    public readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
    public fire(value: T): void { for (const listener of this.listeners) listener(value); }
    public dispose(): void { this.listeners.clear(); }
  }
  class CancellationTokenSource {
    private readonly emitter = new EventEmitter<void>();
    private cancelled = false;
    public readonly token = {
      get isCancellationRequested(): boolean { return false; },
      onCancellationRequested: this.emitter.event,
    };
    public constructor() {
      const source = this;
      Object.defineProperty(this.token, 'isCancellationRequested', { get: () => source.cancelled });
    }
    public cancel(): void { this.cancelled = true; this.emitter.fire(); }
    public dispose(): void { this.emitter.dispose(); }
  }
  return { EventEmitter, CancellationTokenSource, CancellationError: class extends Error {} };
});

import * as vscode from 'vscode';
import { AgyBackendManager } from '../../src/acp/agyBackendManager.js';

function createBackend(): AgyBackendManager {
  const backend = new AgyBackendManager('unused-test-storage', {
    name: 'test', append: vi.fn(), appendLine: vi.fn(), replace: vi.fn(), clear: vi.fn(),
    show: vi.fn(), hide: vi.fn(), dispose: vi.fn(),
  });
  const state = backend as unknown as {
    _isReady: boolean;
    _internalHttpPort: number | undefined;
    bootAuthCompleted: boolean;
    process: { exitCode: number | null; killed: boolean };
    transport: { sendRequest: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  };
  state._isReady = true;
  state._internalHttpPort = 43210;
  state.bootAuthCompleted = true;
  state.process = { exitCode: null, killed: true };
  state.transport = { sendRequest: vi.fn(async () => ({ stopReason: 'end_turn' })), dispose: vi.fn() };
  vi.spyOn(backend, 'ensureStarted').mockResolvedValue();
  return backend;
}

async function prompt(backend: AgyBackendManager, token: vscode.CancellationToken): Promise<void> {
  await backend.prompt('session-1', [{ type: 'text', text: 'test' }], token);
}

describe('backend fully-idle waiting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the session ID and CSRF token to the current backend', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    try {
      await prompt(backend, source.token);
      await backend.waitForConversationFullyIdle('session-1', source.token);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:43210/exa.language_server_pb.LanguageServerService/WaitForConversationFullyIdle',
        expect.objectContaining({
          method: 'POST', body: JSON.stringify({ conversationId: 'session-1' }),
          headers: expect.objectContaining({ 'x-codeium-csrf-token': backend.csrfToken }),
        }),
      );
    } finally {
      source.dispose();
      backend.dispose();
    }
  });

  it.each([
    { status: 503, body: '{}', message: 'HTTP 503' },
    { status: 200, body: '{"unexpected":true}', message: 'unexpected response' },
    { status: 200, body: 'invalid', message: 'Cannot confirm conversation is fully idle' },
  ])('rejects invalid HTTP response $status', async ({ status, body, message }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    try {
      await prompt(backend, source.token);
      await expect(backend.waitForConversationFullyIdle('session-1', source.token)).rejects.toThrow(message);
    } finally {
      source.dispose();
      backend.dispose();
    }
  });

  it.each(['cancel', 'dispose', 'timeout'] as const)('aborts a pending HTTP wait on %s', async (action) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    try {
      await prompt(backend, source.token);
      const waiting = backend.waitForConversationFullyIdle('session-1', source.token);
      const outcome = expect(waiting).rejects.toThrow(/cancelled|disconnected|Timed out/i);
      expect(fetchMock).toHaveBeenCalledOnce();
      if (action === 'cancel') source.cancel();
      if (action === 'dispose') backend.dispose();
      if (action === 'timeout') await vi.advanceTimersByTimeAsync(10 * 60_000);
      await outcome;
    } finally {
      source.dispose();
      backend.dispose();
    }
  });

  it('rejects when the prompt owner has been replaced', async () => {
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    try {
      await prompt(backend, source.token);
      const state = backend as unknown as { process: { exitCode: null; killed: boolean } };
      state.process = { exitCode: null, killed: true };
      await expect(backend.waitForConversationFullyIdle('session-1', source.token)).rejects.toThrow(/restarted/);
    } finally {
      source.dispose();
      backend.dispose();
    }
  });

  it.each(['load', 'prompt'] as const)('does not send a cancelled queued %s', async (operation) => {
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    const gate = Promise.withResolvers<void>();
    const state = backend as unknown as {
      bootAuthCompleted: boolean;
      bootOpQueue: Promise<void>;
      transport: { sendRequest: ReturnType<typeof vi.fn> };
    };
    state.bootAuthCompleted = false;
    state.bootOpQueue = gate.promise;
    try {
      const pending = operation === 'load'
        ? backend.loadSession('session-1', '', source.token)
        : backend.prompt('session-1', [{ type: 'text', text: 'test' }], source.token);
      const rejection = expect(pending).rejects.toThrow();
      await Promise.resolve();
      source.cancel();
      gate.resolve();
      await rejection;
      expect(state.transport.sendRequest).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      source.dispose();
      backend.dispose();
    }
  });

  it('does not run a queued load on a replacement backend process', async () => {
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    const gate = Promise.withResolvers<void>();
    const state = backend as unknown as {
      bootAuthCompleted: boolean;
      bootOpQueue: Promise<void>;
      process: { exitCode: null; killed: boolean };
      transport: { sendRequest: ReturnType<typeof vi.fn> };
    };
    state.bootAuthCompleted = false;
    state.bootOpQueue = gate.promise;
    try {
      const pending = backend.loadSession('session-1', '', source.token);
      const rejection = expect(pending).rejects.toThrow(/restarted/);
      await Promise.resolve();
      state.process = { exitCode: null, killed: true };
      gate.resolve();
      await rejection;
      expect(state.transport.sendRequest).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      source.dispose();
      backend.dispose();
    }
  });
});