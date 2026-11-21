import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { httpRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
}));

vi.mock('node:http', () => ({
  request: httpRequestMock,
}));

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

function stubHttpResponse(statusCode: number, body: string): void {
  httpRequestMock.mockImplementation((_options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.setTimeout = vi.fn(() => req);
    req.destroy = vi.fn();
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        const res = new EventEmitter() as http.IncomingMessage;
        res.statusCode = statusCode;
        cb(res);
        if (body.length > 0) {
          res.emit('data', Buffer.from(body, 'utf8'));
        }
        res.emit('end');
      });
    });
    return req as unknown as http.ClientRequest;
  });
}

describe('backend fully-idle waiting', () => {
  afterEach(() => {
    httpRequestMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the session ID and CSRF token to the current backend with no socket timeout', async () => {
    stubHttpResponse(200, '{}');
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    try {
      await prompt(backend, source.token);
      await backend.waitForConversationFullyIdle('session-1', source.token);
      expect(httpRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: '127.0.0.1',
          port: 43210,
          path: '/exa.language_server_pb.LanguageServerService/WaitForConversationFullyIdle',
          method: 'POST',
          agent: false,
          headers: expect.objectContaining({ 'x-codeium-csrf-token': backend.csrfToken }),
        }),
        expect.any(Function),
      );
      const req = httpRequestMock.mock.results[0]?.value as { setTimeout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      expect(req.setTimeout).toHaveBeenCalledWith(0);
      expect(req.end).toHaveBeenCalledWith(JSON.stringify({ conversationId: 'session-1' }));
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
    stubHttpResponse(status, body);
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
    httpRequestMock.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      req.setTimeout = vi.fn(() => req);
      req.destroy = vi.fn();
      req.end = vi.fn();
      return req as unknown as http.ClientRequest;
    });
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    try {
      await prompt(backend, source.token);
      const waiting = backend.waitForConversationFullyIdle('session-1', source.token);
      const outcome = expect(waiting).rejects.toThrow(/cancelled|disconnected|Timed out/i);
      expect(httpRequestMock).toHaveBeenCalledOnce();
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

  it('does not let an earlier superseded prompt overwrite promptOwners for a newer prompt', async () => {
    stubHttpResponse(200, '{}');
    const backend = createBackend();
    const source = new vscode.CancellationTokenSource();
    const firstPrompt = Promise.withResolvers<{ stopReason: string }>();
    const secondPrompt = Promise.withResolvers<{ stopReason: string }>();
    const state = backend as unknown as {
      transport: { sendRequest: ReturnType<typeof vi.fn> };
      promptOwners: Map<string, unknown>;
    };
    state.transport.sendRequest
      .mockReturnValueOnce(firstPrompt.promise)
      .mockReturnValueOnce(secondPrompt.promise);
    try {
      const p1 = backend.prompt('session-1', [{ type: 'text', text: 'first' }], source.token);
      await Promise.resolve();
      const p2 = backend.prompt('session-1', [{ type: 'text', text: 'second' }], source.token);
      await vi.waitFor(() => expect(state.transport.sendRequest).toHaveBeenCalledTimes(2));

      secondPrompt.resolve({ stopReason: 'end_turn' });
      await p2;
      expect(state.promptOwners.has('session-1')).toBe(true);

      await backend.waitForConversationFullyIdle('session-1', source.token);
      expect(state.promptOwners.has('session-1')).toBe(false);

      firstPrompt.resolve({ stopReason: 'end_turn' });
      await p1;
      expect(state.promptOwners.has('session-1')).toBe(false);
    } finally {
      firstPrompt.resolve({ stopReason: 'end_turn' });
      secondPrompt.resolve({ stopReason: 'end_turn' });
      source.dispose();
      backend.dispose();
    }
  });
});