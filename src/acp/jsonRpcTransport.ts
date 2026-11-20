import { StringDecoder } from 'node:string_decoder';
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './acpTypes.js';

export interface JsonRpcTransportOptions {
  requestTimeoutMs?: number | undefined;
  onNotification?: ((method: string, params: unknown) => void) | undefined;
  onRequest?: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  onError?: ((err: Error) => void) | undefined;
  onClose?: (() => void) | undefined;
}

export class JsonRpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function extractRpcErrorCode(err: unknown): number {
  if (err instanceof JsonRpcError) {
    return err.code;
  }
  if (isRecord(err) && typeof err.code === 'number') {
    return err.code;
  }
  return -32603;
}

export class JsonRpcTransport {
  private readonly readable: NodeJS.ReadableStream;
  private readonly writable: NodeJS.WritableStream;
  private readonly options: JsonRpcTransportOptions;
  private readonly defaultTimeoutMs: number;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 1;
  private disposed = false;
  private closed = false;

  private readonly onDataListener = (chunk: Buffer | string): void => {
    this.handleData(chunk);
  };

  private readonly onEndListener = (): void => {
    this.flushRemainingBuffer();
    this.handleStreamClose();
  };

  private readonly onCloseListener = (): void => {
    this.flushRemainingBuffer();
    this.handleStreamClose();
  };

  private readonly onErrorListener = (err: unknown): void => {
    this.options.onError?.(toError(err));
  };

  public constructor(
    readable: NodeJS.ReadableStream,
    writable: NodeJS.WritableStream,
    options: JsonRpcTransportOptions = {},
  ) {
    this.readable = readable;
    this.writable = writable;
    this.options = options;
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;

    this.readable.on('data', this.onDataListener);
    this.readable.on('end', this.onEndListener);
    this.readable.on('close', this.onCloseListener);
    this.readable.on('error', this.onErrorListener);
    if (!Object.is(this.writable, this.readable)) {
      this.writable.on('error', this.onErrorListener);
    }
  }

  public async sendRequest<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed || this.closed) {
      throw new Error(`Cannot send JSON-RPC request "${method}": transport is closed`);
    }

    const id = this.nextId;
    this.nextId += 1;
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;

    return await new Promise<T>((resolve, reject) => {
      const timer =
        effectiveTimeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(
                new Error(`JSON-RPC request "${method}" (id=${String(id)}) timed out after ${effectiveTimeoutMs}ms`),
              );
            }, effectiveTimeoutMs)
          : undefined;

      this.pendingRequests.set(id, {
        resolve: (value: unknown): void => {
          resolve(value as T);
        },
        reject,
        timer,
      });

      try {
        const request: JsonRpcRequest =
          params !== undefined ? { jsonrpc: '2.0', id, method, params } : { jsonrpc: '2.0', id, method };
        this.writeMessage(request);
      } catch (err: unknown) {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.pendingRequests.delete(id);
        reject(toError(err));
      }
    });
  }

  public sendNotification(method: string, params?: unknown): void {
    if (this.disposed || this.closed) {
      return;
    }
    const notification: JsonRpcNotification =
      params !== undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method };
    this.writeMessage(notification);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachListeners();
    this.rejectAllPending(new Error('JSON-RPC transport disposed'));
    this.buffer = '';
  }

  private detachListeners(): void {
    this.readable.removeListener('data', this.onDataListener);
    this.readable.removeListener('end', this.onEndListener);
    this.readable.removeListener('close', this.onCloseListener);
    this.readable.removeListener('error', this.onErrorListener);
    if (!Object.is(this.writable, this.readable)) {
      this.writable.removeListener('error', this.onErrorListener);
    }
  }

  private handleData(chunk: Buffer | string): void {
    if (this.disposed) {
      return;
    }
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    this.processBuffer();
  }

  private flushRemainingBuffer(): void {
    if (this.disposed) {
      return;
    }
    const trailing = this.decoder.end();
    if (trailing.length > 0) {
      this.buffer += trailing;
    }
    this.processBuffer();
    const remainder = this.buffer.trim();
    this.buffer = '';
    if (remainder.length > 0) {
      this.handleLine(remainder);
    }
  }

  private processBuffer(): void {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.handleLine(trimmed);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (err: unknown) {
      this.options.onError?.(new Error(`Invalid JSON-RPC line: ${toError(err).message}`));
      return;
    }

    if (!isRecord(parsed)) {
      this.options.onError?.(new Error('Invalid JSON-RPC message: expected JSON object'));
      return;
    }

    const method = parsed.method;
    const id = parsed.id;

    if (typeof method === 'string' && isValidRpcId(id)) {
      void this.handleIncomingRequest(id, method, parsed.params);
      return;
    }

    if (typeof method === 'string') {
      try {
        this.options.onNotification?.(method, parsed.params);
      } catch (err: unknown) {
        this.options.onError?.(toError(err));
      }
      return;
    }

    if (isValidRpcId(id)) {
      this.handleIncomingResponse(id, parsed);
    }
  }

  private handleIncomingResponse(id: JsonRpcId, parsed: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }

    if (isRecord(parsed.error)) {
      const code = typeof parsed.error.code === 'number' ? parsed.error.code : -32603;
      const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'JSON-RPC error';
      pending.reject(new JsonRpcError(code, message, parsed.error.data));
      return;
    }

    pending.resolve(parsed.result);
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.options.onRequest;
    if (handler === undefined) {
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }

    try {
      const result = await handler(method, params);
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        result: result ?? null,
      });
    } catch (err: unknown) {
      const error = toError(err);
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: extractRpcErrorCode(err),
          message: error.message,
        },
      });
    }
  }

  private sendResponse(response: JsonRpcResponse): void {
    if (this.disposed || this.closed) {
      return;
    }
    try {
      this.writeMessage(response);
    } catch (err: unknown) {
      this.options.onError?.(toError(err));
    }
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  private handleStreamClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAllPending(new Error('JSON-RPC stream closed'));
    if (!this.disposed) {
      this.options.onClose?.();
    }
  }

  private rejectAllPending(reason: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      this.pendingRequests.delete(id);
      pending.reject(reason);
    }
  }
}
