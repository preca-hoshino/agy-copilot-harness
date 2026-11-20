import type * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode';

type ChatPart = Parameters<vscode.ChatResponseStream['push']>[0];

export class ActiveAgyTurn {
  private readonly parts = new Set<ChatPart>();
  private readonly completed = Promise.withResolvers<void>();
  private readonly switchedView = Promise.withResolvers<void>();
  private readonly stopSource = new CancellationTokenSource();
  private stream: vscode.ChatResponseStream | undefined;
  private requestStream: vscode.ChatResponseStream | undefined;
  private interruptionToken: vscode.CancellationToken | undefined;
  private finished = false;

  public constructor(
    public readonly history: vscode.ChatSession['history'],
    stream: vscode.ChatResponseStream,
    private readonly stopPrompt: () => void,
  ) {
    this.stream = stream;
    this.requestStream = stream;
  }

  public get permissionStream(): vscode.ChatResponseStream | undefined {
    return this.stopToken.isCancellationRequested ? undefined : this.requestStream;
  }

  public get stopToken(): vscode.CancellationToken {
    return this.stopSource.token;
  }

  public get onViewSwitched(): Promise<void> {
    return this.switchedView.promise;
  }

  public push(part: ChatPart): void {
    // Tool and plan updates reuse mutable part objects; replay each once in its original position.
    this.parts.add(part);
    this.send(part);
  }

  public readonly attach = async (
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    if (!this.finished) {
      this.requestStream = undefined;
      this.switchedView.resolve();
    }
    this.stream = stream;
    for (const part of this.parts) {
      this.send(part);
    }
    if (this.finished) {
      this.stream = undefined;
      return;
    }

    // VS Code defers disposal of a live active response until it is interrupted.
    // This is the interruption token, not the cancellable history-load token.
    this.interruptionToken = token;
    const subscription = token.onCancellationRequested(() => {
      if (this.interruptionToken === token) {
        this.stop();
      }
    });
    try {
      if (token.isCancellationRequested) {
        this.stop();
      }
      await this.completed.promise;
    } finally {
      subscription.dispose();
    }
  };

  public stop(): void {
    if (!this.finished && !this.stopToken.isCancellationRequested) {
      this.stopSource.cancel();
      this.switchedView.resolve();
      this.stopPrompt();
    }
  }

  public stopRequestStream(stream: vscode.ChatResponseStream): void {
    if (this.requestStream === stream) {
      this.stop();
    }
  }

  public finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.stream = undefined;
    this.requestStream = undefined;
    this.interruptionToken = undefined;
    this.stopSource.cancel();
    this.stopSource.dispose();
    this.switchedView.resolve();
    this.completed.resolve();
  }

  private send(part: ChatPart): void {
    try {
      this.stream?.push(part);
    } catch {
      // A closed UI stream must not prevent ACP progress or file-change tracking.
      this.stream = undefined;
      this.requestStream = undefined;
      this.switchedView.resolve();
    }
  }
}
