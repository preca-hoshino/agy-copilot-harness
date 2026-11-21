import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { JsonRpcError, JsonRpcTransport } from '../../src/acp/jsonRpcTransport.js';

function createDuplexStreams(): {
  clientReadable: PassThrough;
  clientWritable: PassThrough;
  serverWrite: (text: string | Buffer) => void;
  readClientMessages: () => Array<Record<string, unknown>>;
} {
  const clientReadable = new PassThrough();
  const clientWritable = new PassThrough();
  const sentChunks: string[] = [];

  clientWritable.on('data', (chunk: Buffer | string) => {
    sentChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  const serverWrite = (text: string | Buffer): void => {
    clientReadable.write(text);
  };

  const readClientMessages = (): Array<Record<string, unknown>> => {
    return sentChunks
      .join('')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  return { clientReadable, clientWritable, serverWrite, readClientMessages };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe('JsonRpcTransport', () => {
  it('handles NDJSON split chunks including multibyte UTF-8 and CRLF', async () => {
    const { clientReadable, clientWritable, serverWrite, readClientMessages } = createDuplexStreams();
    const transport = new JsonRpcTransport(clientReadable, clientWritable);

    const requestPromise = transport.sendRequest<{ greeting: string }>('echo', { text: 'test' });
    await waitForCondition(() => readClientMessages().length === 1);

    const req = readClientMessages()[0];
    expect(req?.id).toBe(1);
    expect(req?.method).toBe('echo');

    const fullPayload = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { greeting: '你好🚀Antigravity' } })}\r\n`,
      'utf8',
    );

    // Split right through the middle of multi-byte UTF-8 sequences
    for (let i = 0; i < fullPayload.length; i += 3) {
      serverWrite(fullPayload.subarray(i, Math.min(i + 3, fullPayload.length)));
    }

    const result = await requestPromise;
    expect(result).toEqual({ greeting: '你好🚀Antigravity' });
    transport.dispose();
  });

  it('handles coalesced multi-line chunks containing notifications and responses', async () => {
    const { clientReadable, clientWritable, serverWrite, readClientMessages } = createDuplexStreams();
    const notifications: Array<{ method: string; params: unknown }> = [];

    const transport = new JsonRpcTransport(clientReadable, clientWritable, {
      onNotification: (method, params) => {
        notifications.push({ method, params });
      },
    });

    const p = transport.sendRequest<{ ok: boolean }>('session/list', {});
    await waitForCondition(() => readClientMessages().length === 1);

    const coalesced = [
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { seq: 1 } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { seq: 2 } }),
    ].join('\n');

    serverWrite(`${coalesced}\n`);

    const res = await p;
    expect(res).toEqual({ ok: true });
    expect(notifications).toEqual([
      { method: 'session/update', params: { seq: 1 } },
      { method: 'session/update', params: { seq: 2 } },
    ]);
    transport.dispose();
  });

  it('matches out-of-order responses by id and rejects with JsonRpcError on RPC error', async () => {
    const { clientReadable, clientWritable, serverWrite, readClientMessages } = createDuplexStreams();
    const transport = new JsonRpcTransport(clientReadable, clientWritable);

    const first = transport.sendRequest<string>('first');
    const second = transport.sendRequest<string>('second');
    const third = transport.sendRequest<string>('third');

    await waitForCondition(() => readClientMessages().length === 3);

    serverWrite(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'second-ok' })}\n`);
    serverWrite(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Authentication required' } })}\n`,
    );
    serverWrite(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'first-ok' })}\n`);

    await expect(second).resolves.toBe('second-ok');
    await expect(first).resolves.toBe('first-ok');
    await expect(third).rejects.toSatisfy((err: unknown) => {
      return err instanceof JsonRpcError && err.code === -32000 && err.message === 'Authentication required';
    });

    transport.dispose();
  });

  it('handles bidirectional server->client requests with result and error responses', async () => {
    const { clientReadable, clientWritable, serverWrite, readClientMessages } = createDuplexStreams();

    const onRequest = vi.fn(async (method: string, params: unknown) => {
      if (method === 'fs/read_text_file') {
        return { content: `read:${JSON.stringify(params)}` };
      }
      if (method === 'bad/params') {
        throw new JsonRpcError(-32602, 'Missing path');
      }
      throw new Error('Unexpected failure');
    });

    const transport = new JsonRpcTransport(clientReadable, clientWritable, { onRequest });

    serverWrite(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'fs/read_text_file', params: { path: '/a.ts' } })}\n`,
    );
    serverWrite(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv-2', method: 'bad/params', params: {} })}\n`);
    serverWrite(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'other/fail' })}\n`);

    await waitForCondition(() => readClientMessages().length === 3);

    const messages = readClientMessages();
    expect(messages[0]).toEqual({
      jsonrpc: '2.0',
      id: 'srv-1',
      result: { content: 'read:{"path":"/a.ts"}' },
    });
    expect(messages[1]).toEqual({
      jsonrpc: '2.0',
      id: 'srv-2',
      error: { code: -32602, message: 'Missing path' },
    });
    expect(messages[2]).toEqual({
      jsonrpc: '2.0',
      id: 99,
      error: { code: -32603, message: 'Unexpected failure' },
    });

    transport.dispose();
  });

  it('returns -32601 when server sends a request and no onRequest handler is configured', async () => {
    const { clientReadable, clientWritable, serverWrite, readClientMessages } = createDuplexStreams();
    const transport = new JsonRpcTransport(clientReadable, clientWritable);

    serverWrite(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'terminal/create', params: {} })}\n`);
    await waitForCondition(() => readClientMessages().length === 1);

    expect(readClientMessages()[0]).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not found: terminal/create' },
    });

    transport.dispose();
  });

  it('sends outbound notifications without id', async () => {
    const { clientReadable, clientWritable, readClientMessages } = createDuplexStreams();
    const transport = new JsonRpcTransport(clientReadable, clientWritable);

    transport.sendNotification('session/cancel', { sessionId: 'sess-123' });
    await waitForCondition(() => readClientMessages().length === 1);

    expect(readClientMessages()[0]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'sess-123' },
    });

    transport.dispose();
  });

  it('rejects requests that exceed their timeout', async () => {
    const { clientReadable, clientWritable } = createDuplexStreams();
    const transport = new JsonRpcTransport(clientReadable, clientWritable, { requestTimeoutMs: 50 });

    await expect(transport.sendRequest('never/responds', {})).rejects.toThrow(/timed out after 50ms/);

    transport.dispose();
  });

  it.each(['error', 'close'] as const)('rejects an in-flight request on a writable stream %s', async (event) => {
    const { clientReadable, clientWritable, serverWrite } = createDuplexStreams();
    const onClose = vi.fn();
    const onError = vi.fn();
    const onNotification = vi.fn();
    const transport = new JsonRpcTransport(clientReadable, clientWritable, { onClose, onError, onNotification });
    const outcome = transport.sendRequest('session/prompt', {}, 0).catch((error: unknown) => error);

    try {
      if (event === 'error') {
        const failure = new Error('ACP pipe failed');
        clientWritable.emit('error', failure);
        expect(onError).toHaveBeenCalledWith(failure);
      } else {
        clientWritable.emit('close');
      }
      expect(onClose).toHaveBeenCalledOnce();
      await expect(outcome).resolves.toMatchObject({ message: 'JSON-RPC stream closed' });
      serverWrite('{"jsonrpc":"2.0","method":"session/update"}\n');
      clientReadable.emit('close');
      expect(onNotification).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
      await expect(transport.sendRequest('session/load')).rejects.toThrow(/closed/);
    } finally {
      transport.dispose();
    }
  });

  it('rejects all pending requests cleanly on dispose and blocks new requests', async () => {
    const { clientReadable, clientWritable } = createDuplexStreams();
    const transport = new JsonRpcTransport(clientReadable, clientWritable, { requestTimeoutMs: 10_000 });

    const p1 = transport.sendRequest('pending/1');
    const p2 = transport.sendRequest('pending/2');

    transport.dispose();

    await expect(p1).rejects.toThrow(/disposed/);
    await expect(p2).rejects.toThrow(/disposed/);
    await expect(transport.sendRequest('after/dispose')).rejects.toThrow(/closed/);
  });
});
