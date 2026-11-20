import * as vscode from 'vscode';
import type { AccountQuotaSnapshot, QuotaServiceInterface } from '../shared/contracts.js';

export const GOOGLE_AUTH_PROVIDER_LABEL = 'Google';

const DEFAULT_SCOPES: readonly string[] = ['antigravity'];
const SESSION_TOKEN_PLACEHOLDER = 'antigravity-local-session';

export interface GoogleAuthCallbacks {
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

function buildSessionFromSnapshot(snapshot: AccountQuotaSnapshot): vscode.AuthenticationSession | undefined {
  if (!snapshot.signedIn || snapshot.email === undefined || snapshot.email.trim().length === 0) {
    return undefined;
  }
  const email = snapshot.email.trim();
  return {
    id: email,
    accessToken: SESSION_TOKEN_PLACEHOLDER,
    account: {
      id: email,
      label: email,
    },
    scopes: DEFAULT_SCOPES,
  };
}

function scopesMatch(requestedScopes: readonly string[] | undefined): boolean {
  if (requestedScopes === undefined || requestedScopes.length === 0) {
    return true;
  }
  return requestedScopes.every((scope) => DEFAULT_SCOPES.includes(scope));
}

/**
 * VS Code AuthenticationProvider backed by Antigravity's local Google OAuth state via `AgyQuotaService`.
 */
export class GoogleAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly quotaService: QuotaServiceInterface;
  private readonly callbacks: GoogleAuthCallbacks;
  private readonly sessionsEmitter: vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private readonly snapshotSubscription: vscode.Disposable;

  public readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> =
    this.sessionsEmitter.event;

  private currentSession: vscode.AuthenticationSession | undefined;
  private disposed = false;

  public constructor(quotaService: QuotaServiceInterface, callbacks: GoogleAuthCallbacks) {
    this.quotaService = quotaService;
    this.callbacks = callbacks;
    this.currentSession = buildSessionFromSnapshot(this.quotaService.latestSnapshot);
    this.snapshotSubscription = this.quotaService.onDidChangeSnapshot((snapshot) => {
      this.syncSessionFromSnapshot(snapshot);
    });
  }

  public async getSessions(
    scopes: readonly string[] | undefined,
    options: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    const session = buildSessionFromSnapshot(this.quotaService.latestSnapshot);
    this.currentSession = session;

    if (session === undefined || !scopesMatch(scopes)) {
      return await Promise.resolve([]);
    }

    if (options.account !== undefined && options.account.id !== session.account.id) {
      return await Promise.resolve([]);
    }

    return await Promise.resolve([session]);
  }

  public async createSession(
    _scopes: readonly string[],
    _options: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession> {
    await this.callbacks.login();
    const snapshot = await this.quotaService.refresh(true);
    this.syncSessionFromSnapshot(snapshot);

    const session = buildSessionFromSnapshot(snapshot);
    if (session === undefined) {
      throw new Error('Google Antigravity sign-in was cancelled or did not complete.');
    }
    return session;
  }

  public async removeSession(_sessionId: string): Promise<void> {
    await this.callbacks.logout();
    const snapshot = await this.quotaService.refresh(true);
    this.syncSessionFromSnapshot(snapshot);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.snapshotSubscription.dispose();
    this.sessionsEmitter.dispose();
  }

  private syncSessionFromSnapshot(snapshot: AccountQuotaSnapshot): void {
    if (this.disposed) {
      return;
    }

    const previous = this.currentSession;
    const next = buildSessionFromSnapshot(snapshot);

    if (previous === undefined && next === undefined) {
      return;
    }

    if (previous === undefined && next !== undefined) {
      this.currentSession = next;
      this.sessionsEmitter.fire({
        added: [next],
        removed: undefined,
        changed: undefined,
      });
      return;
    }

    if (previous !== undefined && next === undefined) {
      this.currentSession = undefined;
      this.sessionsEmitter.fire({
        added: undefined,
        removed: [previous],
        changed: undefined,
      });
      return;
    }

    if (previous !== undefined && next !== undefined) {
      if (previous.id !== next.id) {
        this.currentSession = next;
        this.sessionsEmitter.fire({
          added: [next],
          removed: [previous],
          changed: undefined,
        });
        return;
      }

      if (previous.account.label !== next.account.label || previous.accessToken !== next.accessToken) {
        this.currentSession = next;
        this.sessionsEmitter.fire({
          added: undefined,
          removed: undefined,
          changed: [next],
        });
      }
    }
  }
}
