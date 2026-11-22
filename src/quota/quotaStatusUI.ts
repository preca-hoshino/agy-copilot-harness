import * as vscode from 'vscode';
import type {
  AccountQuotaSnapshot,
  ModelQuotaInfo,
  QuotaPoolSummary,
  QuotaServiceInterface,
} from '../shared/contracts.js';

export interface QuotaStatusUIActions {
  openModelsCommand: string;
  openSettingsCommand: string;
  signInCommand: string;
  signOutCommand: string;
}

interface AgyMetaCredits {
  available: number;
  monthly: number;
}

interface AgyMetaPool extends QuotaPoolSummary {
  resetLabel: string;
}

interface AgyChatStatusMeta {
  signedIn: boolean;
  email: string | undefined;
  displayName: string | undefined;
  tierName: string | undefined;
  profilePictureUrl: string | undefined;
  promptCredits: AgyMetaCredits | undefined;
  flowCredits: AgyMetaCredits | undefined;
  pools: AgyMetaPool[];
  commands: {
    manageModels: string;
    openSettings: string;
    signIn: string;
    signOut: string;
  };
}

interface QuotaQuickPickItem extends vscode.QuickPickItem {
  actionCommand?: string | undefined;
  refreshRequested?: boolean | undefined;
}

function formatResetTimeLabel(resetTime?: string, resetsAtEpochSec?: number, showUnavailable = true): string {
  let targetDate: Date | undefined;
  if (resetsAtEpochSec !== undefined && Number.isFinite(resetsAtEpochSec)) {
    targetDate = new Date(resetsAtEpochSec * 1000);
  } else if (resetTime !== undefined && resetTime.trim().length > 0) {
    const parsed = Date.parse(resetTime);
    if (Number.isFinite(parsed)) {
      targetDate = new Date(parsed);
    }
  }

  if (targetDate === undefined || Number.isNaN(targetDate.getTime())) {
    return showUnavailable ? 'Reset time unavailable' : '';
  }

  const date = new Intl.DateTimeFormat(vscode.env.language, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(targetDate);
  return `Resets ${date}`;
}

function formatPoolUsage(pool: QuotaPoolSummary): string {
  return pool.usedPercent === undefined ? 'Usage unavailable' : `${pool.usedPercent}% used`;
}

function formatPoolTiming(pool: QuotaPoolSummary): string {
  return [pool.windowLabel, formatPoolReset(pool)].filter(Boolean).join(' · ');
}

function formatPoolReset(pool: QuotaPoolSummary): string {
  return formatResetTimeLabel(pool.resetTime, pool.resetsAtEpochSec, pool.usedPercent !== 0);
}

function formatPoolSummary(pool: QuotaPoolSummary, markdown = false): string {
  const timing = formatPoolTiming(pool);
  const usage = formatPoolUsage(pool);
  return `${pool.label}: ${markdown ? `**${usage}**` : usage}${timing ? ` (${timing})` : ''}`;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatCreditsSummary(available?: number, monthly?: number): string {
  const availText = available !== undefined ? formatNumber(available) : '0';
  if (monthly !== undefined && monthly > 0) {
    return `${availText} / ${formatNumber(monthly)}`;
  }
  return availText;
}

function buildAsciiProgressBar(remainingFraction: number, width = 12): string {
  const clamped = Math.max(0, Math.min(1, remainingFraction));
  const filled = Math.round(clamped * width);
  const empty = Math.max(0, width - filled);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function getPoolClusterKey(resetTime: string | undefined, remainingFraction: number): string {
  const normalizedReset = resetTime !== undefined && resetTime.trim().length > 0 ? resetTime.trim() : '';
  const clamped = Math.max(0, Math.min(1, remainingFraction));
  return `${normalizedReset}::${Math.round(clamped * 1000)}`;
}

/**
 * Renders Antigravity quota and account UI across the VS Code status bar, Agents popover, and QuickPick.
 */
export class QuotaStatusUI implements vscode.Disposable {
  private readonly quotaService: QuotaServiceInterface;
  private readonly actions: QuotaStatusUIActions;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly chatStatusItem: vscode.ChatStatusItem;
  private readonly snapshotSubscription: vscode.Disposable;
  private readonly configSubscription: vscode.Disposable;
  private disposed = false;

  public constructor(quotaService: QuotaServiceInterface, actions: QuotaStatusUIActions) {
    this.quotaService = quotaService;
    this.actions = actions;

    this.statusBarItem = vscode.window.createStatusBarItem(
      'antigravity.quotaStatus',
      vscode.StatusBarAlignment.Right,
      100.05,
    );
    this.statusBarItem.name = 'Antigravity';

    this.chatStatusItem = vscode.window.createChatStatusItem('antigravity.providerAccount');

    this.snapshotSubscription = this.quotaService.onDidChangeSnapshot((snapshot) => {
      this.update(snapshot);
    });
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('antigravityHarness.showStatusBarQuota')) {
        this.syncStatusBarVisibility();
      }
    });

    this.update(this.quotaService.latestSnapshot);
    this.syncStatusBarVisibility();
  }

  public update(snapshot: AccountQuotaSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.updateStatusBarItem(snapshot);
    this.updateChatStatusItem(snapshot);
  }

  public async showQuotaPicker(): Promise<void> {
    const snapshot =
      this.quotaService.latestSnapshot.fetchedAt === 0
        ? await this.quotaService.refresh()
        : this.quotaService.latestSnapshot;

    const items: QuotaQuickPickItem[] = [];

    if (snapshot.signedIn) {
      const accountItem: QuotaQuickPickItem = {
        label: `$(account) ${snapshot.email ?? snapshot.displayName ?? 'Signed in'}`,
        alwaysShow: true,
      };
      if (snapshot.tierName !== undefined && snapshot.tierName.length > 0) {
        accountItem.description = snapshot.tierName;
      }
      if (snapshot.displayName !== undefined && snapshot.displayName.length > 0) {
        accountItem.detail = `Source: ${snapshot.source} · ${snapshot.displayName}`;
      }
      items.push(accountItem);

      if (snapshot.availablePromptCredits !== undefined || snapshot.monthlyPromptCredits !== undefined) {
        items.push({
          label: '$(zap) Prompt Credits',
          description: formatCreditsSummary(snapshot.availablePromptCredits, snapshot.monthlyPromptCredits),
          alwaysShow: true,
        });
      }

      if (snapshot.availableFlowCredits !== undefined || snapshot.monthlyFlowCredits !== undefined) {
        items.push({
          label: '$(pulse) Flow Credits',
          description: formatCreditsSummary(snapshot.availableFlowCredits, snapshot.monthlyFlowCredits),
          alwaysShow: true,
        });
      }
    } else {
      items.push({
        label: '$(sign-in) Sign In with Google',
        description: 'Not signed in to Antigravity',
        actionCommand: this.actions.signInCommand,
        alwaysShow: true,
      });
    }

    const modelsByPoolKey = new Map<string, ModelQuotaInfo[]>();
    for (const model of snapshot.models) {
      const key = getPoolClusterKey(model.resetTime, model.remainingFraction);
      const group = modelsByPoolKey.get(key);
      if (group !== undefined) {
        group.push(model);
      } else {
        modelsByPoolKey.set(key, [model]);
      }
    }

    const consumedKeys = new Set<string>();
    for (const pool of snapshot.pools) {
      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: [`${pool.label} — ${formatPoolUsage(pool)}`, formatPoolTiming(pool)].filter(Boolean).join(' · '),
      });

      if (pool.modelLabels.length === 0 || pool.remainingFraction === undefined) {
        items.push({ label: formatPoolUsage(pool), description: formatPoolTiming(pool) });
        continue;
      }
      const key = getPoolClusterKey(pool.resetTime, pool.remainingFraction);
      consumedKeys.add(key);
      const poolModels = modelsByPoolKey.get(key) ?? [];
      for (const model of poolModels) {
        const remainingPct = Math.round(Math.max(0, Math.min(1, model.remainingFraction)) * 100);
        const bar = buildAsciiProgressBar(model.remainingFraction);
        items.push({
          label: `$(antigravity-logo) ${model.label}`,
          description: `${bar} ${remainingPct}% remaining`,
          detail: `ID: ${model.modelId} · ${formatResetTimeLabel(model.resetTime)}`,
        });
      }
    }

    const unpooledModels: ModelQuotaInfo[] = [];
    for (const [key, list] of modelsByPoolKey.entries()) {
      if (!consumedKeys.has(key)) {
        unpooledModels.push(...list);
      }
    }

    if (unpooledModels.length > 0) {
      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: 'Other Models',
      });
      for (const model of unpooledModels) {
        const remainingPct = Math.round(Math.max(0, Math.min(1, model.remainingFraction)) * 100);
        const bar = buildAsciiProgressBar(model.remainingFraction);
        items.push({
          label: `$(antigravity-logo) ${model.label}`,
          description: `${bar} ${remainingPct}% remaining`,
          detail: `ID: ${model.modelId} · ${formatResetTimeLabel(model.resetTime)}`,
        });
      }
    }

    items.push({
      kind: vscode.QuickPickItemKind.Separator,
      label: 'Actions',
    });

    items.push({
      label: '$(refresh) Refresh Quotas',
      description: 'Fetch latest status from Antigravity backend',
      refreshRequested: true,
    });

    items.push({
      label: '$(gear) Open Harness Settings',
      actionCommand: this.actions.openSettingsCommand,
    });

    if (snapshot.signedIn) {
      items.push({
        label: '$(sign-out) Sign Out',
        actionCommand: this.actions.signOutCommand,
      });
    }

    const title = snapshot.signedIn ? `Antigravity Quotas (${snapshot.email ?? 'Signed in'})` : 'Antigravity Quotas';

    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Inspect quota pools, prompt/flow credits, and model limits',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (picked === undefined) {
      return;
    }

    if (picked.refreshRequested === true) {
      await this.quotaService.refresh(true);
      await this.showQuotaPicker();
      return;
    }

    if (picked.actionCommand !== undefined && picked.actionCommand.length > 0) {
      await vscode.commands.executeCommand(picked.actionCommand);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.snapshotSubscription.dispose();
    this.configSubscription.dispose();
    this.statusBarItem.dispose();
    this.chatStatusItem.dispose();
  }

  private syncStatusBarVisibility(): void {
    const show = vscode.workspace.getConfiguration('antigravityHarness').get<boolean>('showStatusBarQuota', true);
    if (show) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  private buildMetaJson(snapshot: AccountQuotaSnapshot): string {
    const meta: AgyChatStatusMeta = {
      signedIn: snapshot.signedIn,
      email: snapshot.email,
      displayName: snapshot.displayName,
      tierName: snapshot.tierName,
      profilePictureUrl: snapshot.profilePictureUrl,
      promptCredits:
        snapshot.availablePromptCredits !== undefined || snapshot.monthlyPromptCredits !== undefined
          ? {
              available: snapshot.availablePromptCredits ?? 0,
              monthly: snapshot.monthlyPromptCredits ?? 0,
            }
          : undefined,
      flowCredits:
        snapshot.availableFlowCredits !== undefined || snapshot.monthlyFlowCredits !== undefined
          ? {
              available: snapshot.availableFlowCredits ?? 0,
              monthly: snapshot.monthlyFlowCredits ?? 0,
            }
          : undefined,
      pools: snapshot.pools.map((pool) => ({
        ...pool,
        resetLabel: formatPoolReset(pool),
      })),
      commands: {
        manageModels: this.actions.openModelsCommand,
        openSettings: this.actions.openSettingsCommand,
        signIn: this.actions.signInCommand,
        signOut: this.actions.signOutCommand,
      },
    };
    return JSON.stringify(meta).replaceAll('-->', '--\\u003e');
  }

  private updateStatusBarItem(snapshot: AccountQuotaSnapshot): void {
    this.statusBarItem.text = '$(antigravity-logo)';
    this.statusBarItem.backgroundColor = undefined;

    if (!snapshot.signedIn) {
      this.statusBarItem.accessibilityInformation = { label: 'Antigravity: Sign In' };
      this.statusBarItem.command = this.actions.signInCommand;
    } else {
      this.statusBarItem.accessibilityInformation = {
        label: `Antigravity: ${snapshot.email ?? snapshot.displayName ?? 'Signed in'}`,
      };
      this.statusBarItem.command = this.actions.openModelsCommand;
    }

    const safeMetaJson = this.buildMetaJson(snapshot);
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    tooltip.supportHtml = true;
    tooltip.supportThemeIcons = true;

    tooltip.appendMarkdown(`<!--AGY_META:${safeMetaJson}-->\n`);
    if (snapshot.signedIn) {
      tooltip.appendMarkdown(
        `**${snapshot.email ?? snapshot.displayName ?? 'Antigravity'}**${snapshot.tierName !== undefined ? ` · ${snapshot.tierName}` : ''}\n\n`,
      );
      for (const pool of snapshot.pools) {
        tooltip.appendMarkdown(`- ${formatPoolSummary(pool, true)}\n`);
      }
    } else {
      tooltip.appendMarkdown('Google Antigravity — Not signed in');
    }

    this.statusBarItem.tooltip = tooltip;
  }

  private updateChatStatusItem(snapshot: AccountQuotaSnapshot): void {
    if (vscode.workspace.isAgentSessionsWorkspace !== true) {
      this.chatStatusItem.hide();
      return;
    }

    this.chatStatusItem.title = 'Antigravity';

    if (snapshot.signedIn) {
      const tierSuffix =
        snapshot.tierName !== undefined && snapshot.tierName.length > 0 ? ` (${snapshot.tierName})` : '';
      this.chatStatusItem.description = `${snapshot.email ?? snapshot.displayName ?? 'Signed in'}${tierSuffix}`;
      this.chatStatusItem.detail =
        snapshot.pools.length > 0 ? snapshot.pools.map((pool) => formatPoolSummary(pool)).join(' · ') : 'Active';
    } else {
      this.chatStatusItem.description = 'Not signed in';
      this.chatStatusItem.detail = snapshot.errorMessage ?? 'Sign in with Google Antigravity';
    }

    // Pass metadata as a plain string because ExtHostChatStatus forwards tooltip without MarkdownString serialization.
    const safeMetaJson = this.buildMetaJson(snapshot);
    this.chatStatusItem.tooltip = `<!--AGY_META:${safeMetaJson}-->`;
    this.chatStatusItem.show();
  }
}
