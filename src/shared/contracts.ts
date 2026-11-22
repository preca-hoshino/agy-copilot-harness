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
export type FileWriteHandler = (uri: vscode.Uri, write: () => Promise<void>) => Promise<void>;

export interface AgySlashCommandDescriptor {
  name: string;
  description?: string | undefined;
  argumentHint?: string | undefined;
  source: 'acp' | 'ls';
}

export interface AgyTurnFileDiff {
  originalContent?: string | undefined;
  modifiedContent?: string | undefined;
}

export interface AgyForkConversationResult {
  newCascadeId: string;
}

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
  registerFileWriteHandler?: (sessionId: string, handler: FileWriteHandler) => vscode.Disposable;
  getAvailableCommands?: (sessionId?: string) => AgySlashCommandDescriptor[];
  onDidChangeAvailableCommands?: (listener: () => void) => vscode.Disposable;
  fetchSlashCommands?: (workspaceUris?: string[], sessionId?: string) => Promise<AgySlashCommandDescriptor[]>;
  forkConversation?: (
    sourceCascadeId: string,
    forkAtStepIndex?: number,
  ) => Promise<AgyForkConversationResult | undefined>;
  getTurnFileDiff?: (
    conversationId: string,
    fileUri: string,
    stepIndex?: number,
  ) => Promise<AgyTurnFileDiff | undefined>;
  acknowledgeCodeEdit?: (cascadeId: string, absoluteUri: string, contents: string, accept: boolean) => Promise<boolean>;
  ensureStarted: () => Promise<void>;
  listSessions: () => Promise<AcpSessionListResult>;
  loadSession: (sessionId: string, cwd: string, token?: vscode.CancellationToken) => Promise<AcpSessionLoadResult>;
  resumeSession: (sessionId: string, cwd: string) => Promise<AcpSessionLoadResult>;
  newSession: (cwd: string) => Promise<AcpSessionLoadResult>;
  setConfigOption: (sessionId: string, configId: string, value: string) => Promise<AcpConfigOption[] | undefined>;
  prompt: (
    sessionId: string,
    content: AcpContentBlock[],
    token?: vscode.CancellationToken,
  ) => Promise<AcpSessionPromptResult>;
  waitForConversationFullyIdle: (sessionId: string, token: vscode.CancellationToken) => Promise<void>;
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
