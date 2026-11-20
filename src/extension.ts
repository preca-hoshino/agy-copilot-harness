import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgyBackendManager } from './acp/agyBackendManager.js';
import { GOOGLE_AUTH_PROVIDER_LABEL, GoogleAuthenticationProvider } from './auth/googleAuthenticationProvider.js';
import { checkAndEnsureProposedApi } from './bootstrap/argvPatcher.js';
import { AgyLanguageModelProvider } from './models/agyLanguageModelProvider.js';
import { AgyQuotaService } from './quota/agyQuotaService.js';
import { QuotaStatusUI } from './quota/quotaStatusUI.js';
import { AgyChatParticipant } from './sessions/agyChatParticipant.js';
import { AgySessionContentProvider } from './sessions/agySessionContentProvider.js';
import { AgySessionController } from './sessions/agySessionController.js';
import { BrowserSubagentRenderer, openMediaPreviewPanel } from './sessions/browserSubagentRenderer.js';
import { ANTIGRAVITY_SCHEME, AUTH_PROVIDER_ID, EXTENSION_ID } from './shared/contracts.js';

const LOGIN_POLL_INTERVAL_MS = 1500;
const LOGIN_POLL_MAX_ATTEMPTS = 40;
const DEFAULT_QUOTA_POLL_SEC = 60;
const AUTH_SCOPES: readonly string[] = ['antigravity'];

async function syncTrustedExtensionUsage(createIfNone = false): Promise<void> {
  try {
    const existing = await vscode.authentication.getSession(AUTH_PROVIDER_ID, AUTH_SCOPES, { silent: true });
    if (existing !== undefined || !createIfNone) {
      return;
    }
    await vscode.authentication.getSession(AUTH_PROVIDER_ID, AUTH_SCOPES, { createIfNone: true });
  } catch {
    // Ignore errors when authentication provider is not ready or access prompt was declined.
  }
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveCliExecutable(): string {
  const config = vscode.workspace.getConfiguration('antigravityHarness');
  const configured = config.get<string>('cliPath')?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }

  const binaryName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const defaultBin = path.join(os.homedir(), '.gemini', 'bin', binaryName);
  if (isExistingFile(defaultBin)) {
    return defaultBin;
  }

  return binaryName;
}

function resolveAppDataDir(): string {
  const config = vscode.workspace.getConfiguration('antigravityHarness');
  const configured = config.get<string>('appDataDir')?.trim();
  return configured !== undefined && configured.length > 0 ? configured : 'antigravity';
}

function resolveQuotaIntervalSec(): number {
  const config = vscode.workspace.getConfiguration('antigravityHarness');
  const configured = config.get<number>('quotaRefreshIntervalSec');
  if (configured !== undefined && Number.isFinite(configured) && configured >= 15) {
    return configured;
  }
  return DEFAULT_QUOTA_POLL_SEC;
}

function quoteShellArg(arg: string): string {
  if (/^[^\s"'`$&|;<>()]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll('"', '\\"')}"`;
}

function resolveMediaArgPath(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    if (trimmed.startsWith('file://')) {
      try {
        return vscode.Uri.parse(trimmed).fsPath;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (arg instanceof vscode.Uri) {
    return arg.fsPath;
  }

  if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
    const record = arg as Record<string, unknown>;
    if (typeof record.path === 'string' && record.path.trim().length > 0) {
      return record.path.trim();
    }
    if (typeof record.uri === 'string' && record.uri.trim().length > 0) {
      return resolveMediaArgPath(record.uri);
    }
  }

  return undefined;
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runInteractiveLoginFlow(
  backend: AgyBackendManager,
  quotaService: AgyQuotaService,
  sessionController: AgySessionController,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const cliPath = resolveCliExecutable();
  const appDataDir = resolveAppDataDir();
  const terminal = vscode.window.createTerminal({ name: 'Antigravity Sign In' });
  terminal.show(false);
  terminal.sendText(`${quoteShellArg(cliPath)} acp --login --app-data-dir ${quoteShellArg(appDataDir)}`, true);

  const terminalState = { closed: false };
  const closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
    if (closed === terminal) {
      terminalState.closed = true;
    }
  });

  try {
    for (let attempt = 0; attempt < LOGIN_POLL_MAX_ATTEMPTS; attempt += 1) {
      if (terminalState.closed) {
        break;
      }
      await delayMs(LOGIN_POLL_INTERVAL_MS);
      const snapshot = await quotaService.refresh(true);
      if (snapshot.signedIn) {
        break;
      }
    }

    await backend.restart();
    await quotaService.refresh(true);
    await sessionController.refreshSessions();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Extension] Interactive login flow error: ${message}`);
  } finally {
    closeSubscription.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Antigravity Harness');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityHarness.patchArgvAndReload', async (): Promise<void> => {
      const enabled = await checkAndEnsureProposedApi(EXTENSION_ID, outputChannel);
      if (enabled) {
        void vscode.window.showInformationMessage('Antigravity Harness proposed APIs are already enabled.');
      }
    }),
  );

  const proposedReady = await checkAndEnsureProposedApi(EXTENSION_ID, outputChannel);
  if (!proposedReady) {
    outputChannel.appendLine('[Extension] Waiting for VS Code reload to activate proposed APIs.');
    return;
  }

  const backend = new AgyBackendManager(context.globalStorageUri.fsPath, outputChannel);
  const quotaService = new AgyQuotaService(backend, outputChannel);
  const browserRenderer = new BrowserSubagentRenderer();
  const lmProvider = new AgyLanguageModelProvider(backend, quotaService);
  const sessionController = new AgySessionController(backend, outputChannel);
  const attachmentDir = path.join(context.globalStorageUri.fsPath, 'attachments');
  const contentProvider = new AgySessionContentProvider(backend, sessionController, browserRenderer, outputChannel, attachmentDir);
  const chatParticipant = new AgyChatParticipant(
    backend,
    sessionController,
    lmProvider,
    quotaService,
    browserRenderer,
    outputChannel,
    (sessionId: string, mode: string): void => {
      backend.setSessionMode(sessionId, mode);
    },
    attachmentDir,
  );

  const participant = vscode.chat.createChatParticipant(ANTIGRAVITY_SCHEME, chatParticipant.createHandler());

  const runLogin = async (): Promise<void> => {
    await runInteractiveLoginFlow(backend, quotaService, sessionController, outputChannel);
  };

  const runLogout = async (): Promise<void> => {
    try {
      await backend.logout();
      await quotaService.refresh(true);
      await sessionController.refreshSessions();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Extension] Sign-out failed: ${message}`);
      void vscode.window.showErrorMessage(`Antigravity sign-out failed: ${message}`);
    }
  };

  const googleAuthProvider = new GoogleAuthenticationProvider(quotaService, {
    login: runLogin,
    logout: runLogout,
  });

  let lastRecordedSignedInEmail: string | undefined;
  const authUsageSubscription = quotaService.onDidChangeSnapshot((snapshot) => {
    const email = snapshot.signedIn ? snapshot.email?.trim() : undefined;
    if (email !== undefined && email.length > 0 && email !== lastRecordedSignedInEmail) {
      lastRecordedSignedInEmail = email;
      void syncTrustedExtensionUsage(false);
    } else if (!snapshot.signedIn) {
      lastRecordedSignedInEmail = undefined;
    }
  });

  const quotaStatusUI = new QuotaStatusUI(quotaService, {
    openModelsCommand: 'antigravityHarness.showQuotaPicker',
    openSettingsCommand: 'antigravityHarness.openSettings',
    signInCommand: 'antigravityHarness.signIn',
    signOutCommand: 'antigravityHarness.signOut',
  });

  context.subscriptions.push(
    backend,
    quotaService,
    lmProvider,
    sessionController,
    contentProvider,
    chatParticipant,
    participant,
    googleAuthProvider,
    authUsageSubscription,
    quotaStatusUI,
    vscode.lm.registerLanguageModelChatProvider('antigravity', lmProvider),
    vscode.chat.registerChatSessionContentProvider(ANTIGRAVITY_SCHEME, contentProvider, participant, {
      supportsInterruptions: true,
    }),
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID,
      GOOGLE_AUTH_PROVIDER_LABEL,
      googleAuthProvider,
      { supportsMultipleAccounts: false },
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('antigravityHarness.quotaRefreshIntervalSec')) {
        quotaService.startPolling(resolveQuotaIntervalSec());
      }
    }),
    vscode.commands.registerCommand('antigravityHarness.showQuotaPicker', async (): Promise<void> => {
      await quotaStatusUI.showQuotaPicker();
    }),
    vscode.commands.registerCommand('antigravityHarness.manageModels', async (): Promise<void> => {
      void quotaService.refresh();
      await vscode.commands.executeCommand('workbench.action.chat.manage', '@provider:"Antigravity"', ANTIGRAVITY_SCHEME);
    }),
    vscode.commands.registerCommand('antigravityHarness.signIn', async (): Promise<void> => {
      await runLogin();
      if (quotaService.latestSnapshot.signedIn) {
        await syncTrustedExtensionUsage(true);
      }
    }),
    vscode.commands.registerCommand('antigravityHarness.signOut', async (): Promise<void> => {
      await runLogout();
    }),
    vscode.commands.registerCommand('antigravityHarness.openSettings', async (): Promise<void> => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
    }),
    vscode.commands.registerCommand('antigravityHarness.restartBackend', async (): Promise<void> => {
      await backend.restart();
      await sessionController.refreshSessions();
      await quotaService.refresh(true);
    }),
    vscode.commands.registerCommand('antigravityHarness.refreshSessions', async (): Promise<void> => {
      await sessionController.refreshSessions();
      await quotaService.refresh(true);
    }),
    vscode.commands.registerCommand(
      'antigravityHarness.openMediaPreview',
      async (mediaArg?: unknown, titleArg?: unknown): Promise<void> => {
        let resolvedPath = resolveMediaArgPath(mediaArg);
        if (resolvedPath === undefined) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
              Media: ['webm', 'webp', 'png', 'jpg', 'jpeg'],
            },
            title: 'Select Antigravity Browser Recording or Screenshot',
          });
          resolvedPath = picked?.[0]?.fsPath;
        }

        if (resolvedPath !== undefined && resolvedPath.length > 0) {
          const title = typeof titleArg === 'string' && titleArg.length > 0 ? titleArg : undefined;
          openMediaPreviewPanel(resolvedPath, title);
        }
      },
    ),
  );

  quotaService.startPolling(resolveQuotaIntervalSec());

  void quotaService.refresh().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Extension] Initial quota refresh warning: ${message}`);
  });

  void (async (): Promise<void> => {
    try {
      await backend.ensureStarted();
      await sessionController.refreshSessions();
      await quotaService.refresh(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Extension] Initial backend warmup warning: ${message}`);
    }
  })();
}

export function deactivate(): void {
  // All resources are disposed automatically via context.subscriptions.
}
