import * as vscode from 'vscode';
import type { AcpBackendInterface } from '../shared/contracts.js';

const queues = new WeakMap<AcpBackendInterface, Map<string, Promise<void>>>();

/** Keep replay and live updates for a session from being consumed at the same time. */
export async function acquireSessionOperation(
  backend: AcpBackendInterface,
  sessionId: string,
  token: vscode.CancellationToken,
): Promise<() => void> {
  let sessions = queues.get(backend);
  if (sessions === undefined) {
    sessions = new Map();
    queues.set(backend, sessions);
  }

  const previous = sessions.get(sessionId) ?? Promise.resolve();
  let releaseGate: () => void = () => {
    // Replaced synchronously by the promise executor below.
  };
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(async () => {
    await gate;
  });
  sessions.set(sessionId, tail);
  const sessionQueues = sessions;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    releaseGate();
    void tail.then(() => {
      if (sessionQueues.get(sessionId) === tail) {
        sessionQueues.delete(sessionId);
      }
    });
  };

  let subscription: vscode.Disposable | undefined;
  try {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (typeof token.onCancellationRequested === 'function') {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          subscription = token.onCancellationRequested(() => {
            reject(new vscode.CancellationError());
          });
        }),
      ]);
    } else {
      await previous;
    }
    if (isCancelled(token)) {
      throw new vscode.CancellationError();
    }
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    subscription?.dispose();
  }
}

function isCancelled(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}