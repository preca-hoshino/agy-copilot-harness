import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import * as zlib from 'node:zlib';
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

  it('reads chunked Connect frames from StreamAgentStateUpdates and attaches generator outputTokens', async () => {
    const streamFrameJson = JSON.stringify({
      update: {
        contextWindowUsage: {
          generatorMetadataIndex: 4,
          estimatedTokensUsed: 62_000,
          maxContextTokens: 256_000,
          estimatedAfterCompaction: 12_000,
          tokenGroups: [
            { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 8_000 },
            { name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', source: 'TOKEN_SOURCE_USER', numTokens: 54_000 },
          ],
        },
      },
    });
    const streamBytes = Buffer.from(streamFrameJson, 'utf8');
    const streamEnvelope = Buffer.alloc(5 + streamBytes.length);
    streamEnvelope.writeUInt8(0, 0);
    streamEnvelope.writeUInt32BE(streamBytes.length, 1);
    streamBytes.copy(streamEnvelope, 5);

    const metadataJson = JSON.stringify({
      generatorMetadata: [
        { chatModel: { usage: { inputTokens: 60_000, outputTokens: '2450' } } },
      ],
    });

    const recordedRequests: Array<{ path?: string | null | undefined; body: Buffer }> = [];
    httpRequestMock.mockImplementation((options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
      const bodyChunks: Buffer[] = [];
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      req.setTimeout = vi.fn(() => req);
      req.destroy = vi.fn();
      req.end = vi.fn((chunk?: Buffer | string) => {
        if (chunk !== undefined) {
          bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        }
        recordedRequests.push({ path: options.path, body: Buffer.concat(bodyChunks) });
        queueMicrotask(() => {
          const res = new EventEmitter() as http.IncomingMessage;
          res.statusCode = 200;
          cb(res);
          if (options.path?.endsWith('/StreamAgentStateUpdates') === true) {
            res.emit('data', streamEnvelope.subarray(0, 3));
            res.emit('data', streamEnvelope.subarray(3, 20));
            res.emit('data', streamEnvelope.subarray(20));
          } else {
            res.emit('data', Buffer.from(metadataJson, 'utf8'));
            res.emit('end');
          }
        });
      });
      return req as unknown as http.ClientRequest;
    });

    const backend = createBackend();
    try {
      const usage = await backend.getSessionContextUsage('session-usage-1');
      expect(usage).toEqual({
        estimatedTokensUsed: 62_000,
        maxContextTokens: 256_000,
        estimatedAfterCompaction: 12_000,
        completionTokens: 2_450,
        modelTotals: [{ model: 'Antigravity', inputTokens: 60_000, cachedTokens: 0, outputTokens: 2_450 }],
        tokenGroups: [
          { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 8_000 },
          { name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', source: 'TOKEN_SOURCE_USER', numTokens: 54_000 },
        ],
      });
      expect(recordedRequests).toHaveLength(2);
      const streamReqEnvelope = recordedRequests[0]?.body;
      expect(streamReqEnvelope?.readUInt8(0)).toBe(0);
      const decodedStreamReq = JSON.parse(streamReqEnvelope?.subarray(5).toString('utf8') ?? '{}');
      expect(decodedStreamReq).toMatchObject({
        conversationId: 'session-usage-1',
        initialStepsPageBounds: { startIndex: 0, endIndexExclusive: 0 },
      });
    } finally {
      backend.dispose();
    }
  });

  it('supports gzipped Connect response frames and fails soft on trailer errors', async () => {
    const gzipped = zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          update: {
            contextWindowUsage: {
              estimatedTokensUsed: 15_000,
              maxContextTokens: 512_000,
              tokenGroups: [
                { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 15_000 },
              ],
            },
          },
        }),
        'utf8',
      ),
    );
    const gzipEnvelope = Buffer.alloc(5 + gzipped.length);
    gzipEnvelope.writeUInt8(1, 0);
    gzipEnvelope.writeUInt32BE(gzipped.length, 1);
    gzipped.copy(gzipEnvelope, 5);

    const trailerBytes = Buffer.from('{"error":{"code":"not_found"}}', 'utf8');
    const trailerEnvelope = Buffer.alloc(5 + trailerBytes.length);
    trailerEnvelope.writeUInt8(2, 0);
    trailerEnvelope.writeUInt32BE(trailerBytes.length, 1);
    trailerBytes.copy(trailerEnvelope, 5);

    let callCount = 0;
    httpRequestMock.mockImplementation((_options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
      callCount += 1;
      const responseBuf = callCount === 1 ? gzipEnvelope : trailerEnvelope;
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
          res.statusCode = 200;
          cb(res);
          res.emit('data', responseBuf);
        });
      });
      return req as unknown as http.ClientRequest;
    });

    const backend = createBackend();
    try {
      const gzippedResult = await backend.getSessionContextUsage('session-gzip');
      expect(gzippedResult?.estimatedTokensUsed).toBe(15_000);
      expect(gzippedResult?.maxContextTokens).toBe(512_000);

      const trailerResult = await backend.getSessionContextUsage('session-missing');
      expect(trailerResult).toBeUndefined();
    } finally {
      backend.dispose();
    }
  });
});