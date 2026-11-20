import type * as vscode from 'vscode';
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpRequestPermissionParams,
  AcpSessionListResult,
  AcpSessionLoadResult,
  AcpSessionPromptResult,
  AcpSessionUpdate,
} from '../acp/acpTypes.js';

export const ANTIGRAVITY_SCHEME = 'antigravity';
export const EXTENSION_ID = 'antigravity.agy-copilot-harness';
export const AUTH_PROVIDER_ID = 'google-antigravity';

export type PermissionPrompt = (request: AcpRequestPermissionParams) => Promise<string | undefined>;

export interface ModelQuotaInfo {
  label: string;
  modelId: string;
  description?: string | undefined;
  remainingFraction: number;
  resetTime?: string | undefined;
  supportsThinking?: boolean | undefined;
  supportsImages?: boolean | undefined;
}

export interface QuotaPoolSummary {
  id: string;
  label: string;
  windowLabel?: string | undefined;
  remainingFraction?: number | undefined;
  usedPercent?: number | undefined;
  resetTime?: string | undefined;
  resetsAtEpochSec?: number | undefined;
  modelLabels: string[];
}

export interface AccountQuotaSnapshot {
  signedIn: boolean;
  email?: string | undefined;
  displayName?: string | undefined;
  tierId?: string | undefined;
  tierName?: string | undefined;
  profilePictureUrl?: string | undefined;
  availablePromptCredits?: number | undefined;
  monthlyPromptCredits?: number | undefined;
  availableFlowCredits?: number | undefined;
  monthlyFlowCredits?: number | undefined;
  models: ModelQuotaInfo[];
  pools: QuotaPoolSummary[];
  fetchedAt: number;
  source: 'acp-http' | 'daemon-hub' | 'unauthenticated' | 'error';
  errorMessage?: string | undefined;
}

export interface AcpBackendInterface {
  readonly isReady: boolean;
  readonly internalHttpPort: number | undefined;
  readonly csrfToken: string;
  readonly onDidChangeUpdate: vscode.Event<{ sessionId: string; update: AcpSessionUpdate }>;
  readonly onDidChangeBackendState: vscode.Event<{ ready: boolean; error?: string | undefined }>;
  registerPermissionPrompt?: (sessionId: string, prompt: PermissionPrompt) => vscode.Disposable;
  ensureStarted: () => Promise<void>;
  listSessions: () => Promise<AcpSessionListResult>;
  loadSession: (sessionId: string, cwd: string) => Promise<AcpSessionLoadResult>;
  resumeSession: (sessionId: string, cwd: string) => Promise<AcpSessionLoadResult>;
  newSession: (cwd: string) => Promise<AcpSessionLoadResult>;
  setConfigOption: (sessionId: string, configId: string, value: string) => Promise<AcpConfigOption[] | undefined>;
  prompt: (sessionId: string, content: AcpContentBlock[]) => Promise<AcpSessionPromptResult>;
  cancel: (sessionId: string) => Promise<void>;
  logout: () => Promise<void>;
  restart: () => Promise<void>;
  getLastKnownConfigOptions: () => AcpConfigOption[];
}

export interface QuotaServiceInterface {
  readonly latestSnapshot: AccountQuotaSnapshot;
  readonly onDidChangeSnapshot: vscode.Event<AccountQuotaSnapshot>;
  refresh: (force?: boolean) => Promise<AccountQuotaSnapshot>;
  getModelQuota: (modelId: string) => ModelQuotaInfo | undefined;
}
