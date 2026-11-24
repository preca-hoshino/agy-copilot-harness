import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  AccountQuotaSnapshot,
  AcpBackendInterface,
  ModelQuotaInfo,
  QuotaPoolSummary,
  QuotaServiceInterface,
} from '../shared/contracts.js';

const HTTP_TIMEOUT_MS = 5000;
const HUB_FILE_PATTERN = /^hub_\d+\.json$/;

interface ClusterAccumulator {
  resetTime: string | undefined;
  remainingFraction: number;
  models: ModelQuotaInfo[];
}

interface HubDaemonInfo {
  pid: number;
  httpPort: number;
  csrfToken: string;
  mtimeMs: number;
}

export interface AvailableModelLimits {
  readonly modelKey: string;
  readonly modelId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly remainingFraction?: number | undefined;
  readonly resetTime?: string | undefined;
  readonly supportsThinking?: boolean | undefined;
  readonly supportsImages?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inferSupportsImages(supportedMimeTypes: unknown): boolean | undefined {
  if (!isRecord(supportedMimeTypes)) {
    return undefined;
  }
  for (const [mimeType, supported] of Object.entries(supportedMimeTypes)) {
    if (mimeType.startsWith('image/') && supported === true) {
      return true;
    }
  }
  return undefined;
}

function createEmptySnapshot(
  source: AccountQuotaSnapshot['source'],
  fetchedAt: number,
  errorMessage?: string,
): AccountQuotaSnapshot {
  const snapshot: AccountQuotaSnapshot = {
    signedIn: false,
    models: [],
    pools: [],
    fetchedAt,
    source,
  };
  if (errorMessage !== undefined && errorMessage.length > 0) {
    snapshot.errorMessage = errorMessage;
  }
  return snapshot;
}

function extractFamilyToken(label: string): string {
  const cleaned = label.replace(/\([^)]*\)/g, '').trim();
  const firstToken = cleaned.split(/\s+/)[0];
  return firstToken !== undefined && firstToken.length > 0 ? firstToken : label;
}

const FAMILY_ORDER = ['Gemini', 'Gemini Argon', 'Claude', 'GPT OSS', 'GPT'] as const;

function classifyModelFamily(label: string): string {
  const normalized = label.trim();
  if (/\bargon\b/i.test(normalized)) {
    return 'Gemini Argon';
  }
  if (/^gemini\b/i.test(normalized) || /\bneon\b/i.test(normalized)) {
    return 'Gemini';
  }
  if (/^claude\b/i.test(normalized)) {
    return 'Claude';
  }
  if (/\bgpt[\s-]*oss\b/i.test(normalized)) {
    return 'GPT OSS';
  }
  if (/^gpt\b/i.test(normalized)) {
    return 'GPT';
  }
  return extractFamilyToken(normalized);
}

function inferPrimaryGroupName(modelLabels: readonly string[]): string {
  if (modelLabels.length === 0) {
    return 'Models';
  }

  const familySet = new Set<string>();
  for (const label of modelLabels) {
    familySet.add(classifyModelFamily(label));
  }

  const orderedFamilies: string[] = [];
  for (const known of FAMILY_ORDER) {
    if (familySet.has(known)) {
      orderedFamilies.push(known);
      familySet.delete(known);
    }
  }
  for (const remaining of familySet) {
    orderedFamilies.push(remaining);
  }

  if (orderedFamilies.length > 0) {
    return orderedFamilies.join(' & ');
  }

  return modelLabels[0] ?? 'Models';
}

function slugifyPoolSuffix(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'group';
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function snapshotsEqual(prev: AccountQuotaSnapshot, next: AccountQuotaSnapshot): boolean {
  if (
    prev.signedIn !== next.signedIn ||
    prev.email !== next.email ||
    prev.displayName !== next.displayName ||
    prev.tierId !== next.tierId ||
    prev.tierName !== next.tierName ||
    prev.profilePictureUrl !== next.profilePictureUrl ||
    prev.availablePromptCredits !== next.availablePromptCredits ||
    prev.monthlyPromptCredits !== next.monthlyPromptCredits ||
    prev.availableFlowCredits !== next.availableFlowCredits ||
    prev.monthlyFlowCredits !== next.monthlyFlowCredits ||
    prev.source !== next.source ||
    prev.errorMessage !== next.errorMessage ||
    prev.pools.length !== next.pools.length ||
    prev.models.length !== next.models.length
  ) {
    return false;
  }

  for (let i = 0; i < prev.pools.length; i += 1) {
    const a = prev.pools[i];
    const b = next.pools[i];
    if (
      a === undefined ||
      b === undefined ||
      a.id !== b.id ||
      a.label !== b.label ||
      a.windowLabel !== b.windowLabel ||
      a.usedPercent !== b.usedPercent ||
      a.resetTime !== b.resetTime ||
      a.modelLabels.length !== b.modelLabels.length
    ) {
      return false;
    }
  }

  for (let i = 0; i < prev.models.length; i += 1) {
    const a = prev.models[i];
    const b = next.models[i];
    if (
      a === undefined ||
      b === undefined ||
      a.modelId !== b.modelId ||
      a.description !== b.description ||
      a.remainingFraction !== b.remainingFraction ||
      a.resetTime !== b.resetTime ||
      a.maxTokens !== b.maxTokens ||
      a.maxOutputTokens !== b.maxOutputTokens
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Clusters model quota entries into summary pools by `(resetTime, remainingFraction)`.
 */
export function clusterModelQuotas(models: readonly ModelQuotaInfo[]): QuotaPoolSummary[] {
  if (models.length === 0) {
    return [];
  }

  const modelsWithReset = models.filter((model) => model.resetTime !== undefined && model.resetTime.trim().length > 0);
  const candidates = modelsWithReset.length > 0 ? modelsWithReset : models;

  const groups = new Map<string, ClusterAccumulator>();
  for (const model of candidates) {
    const normalizedFraction = clampFraction(model.remainingFraction);
    const normalizedResetTime = getNonEmptyString(model.resetTime);
    const key = `${normalizedResetTime ?? ''}::${Math.round(normalizedFraction * 1000)}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.models.push(model);
    } else {
      groups.set(key, {
        resetTime: normalizedResetTime,
        remainingFraction: normalizedFraction,
        models: [model],
      });
    }
  }

  const summaries: QuotaPoolSummary[] = [];
  const usedIds = new Set<string>();
  for (const group of groups.values()) {
    const modelLabels = group.models.map((model) => model.label);
    const groupName = inferPrimaryGroupName(modelLabels);
    const baseId = `default-${slugifyPoolSuffix(groupName)}`;
    let uniqueId = baseId;
    let suffix = 2;
    while (usedIds.has(uniqueId)) {
      uniqueId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(uniqueId);

    summaries.push({
      id: uniqueId,
      label: groupName,
      remainingFraction: group.remainingFraction,
      usedPercent: Math.round((1 - group.remainingFraction) * 100),
      resetTime: group.resetTime,
      resetsAtEpochSec: toEpochSeconds(group.resetTime),
      modelLabels,
    });
  }

  summaries.sort((a, b) => {
    const resetA = a.resetsAtEpochSec ?? Number.MAX_SAFE_INTEGER;
    const resetB = b.resetsAtEpochSec ?? Number.MAX_SAFE_INTEGER;
    if (resetA !== resetB) {
      return resetA - resetB;
    }
    if (a.usedPercent !== b.usedPercent) {
      return (b.usedPercent ?? 0) - (a.usedPercent ?? 0);
    }
    return a.id.localeCompare(b.id);
  });

  return summaries;
}

function toEpochSeconds(resetTime: string | undefined): number | undefined {
  const time = resetTime === undefined ? Number.NaN : Date.parse(resetTime);
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined;
}

/** Parses the local LanguageServerService wrapper, preserving each backend bucket. */
export function parseQuotaSummary(payload: unknown): QuotaPoolSummary[] {
  if (!isRecord(payload) || !isRecord(payload.response)) {
    return [];
  }
  const { groups, buckets } = payload.response;
  const pools = new Map<string, QuotaPoolSummary>();
  const addBuckets = (entries: unknown[], groupName?: string): void => {
    for (const bucket of entries) {
      if (!isRecord(bucket) || bucket.disabled === true) {
        continue;
      }
      const id = getNonEmptyString(bucket.bucketId);
      if (id === undefined || pools.has(id)) {
        continue;
      }
      const displayName = getNonEmptyString(bucket.displayName) ?? id;
      const period = getNonEmptyString(bucket.window) ?? id;
      const windowLabel = /weekly|^(?:7d|168h)$/i.test(period)
        ? 'Weekly'
        : /(?:^|[-_\s])5[-_\s]*h(?:ours?)?$/i.test(period)
          ? '5-Hour'
          : undefined;
      const name = groupName ?? displayName;
      const label = name.replace(/\s*\((?:weekly|5[-\s]*hours?)\)\s*$/i, '').trim();
      const fraction = getFiniteNumber(bucket.remainingFraction);
      const remainingFraction = fraction === undefined ? undefined : clampFraction(fraction);
      const resetTime = getNonEmptyString(bucket.resetTime);
      pools.set(id, {
        id,
        label,
        windowLabel,
        remainingFraction,
        usedPercent: remainingFraction === undefined ? undefined : Math.round((1 - remainingFraction) * 100),
        resetTime,
        resetsAtEpochSec: toEpochSeconds(resetTime),
        modelLabels: [],
      });
    }
  };
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (isRecord(group) && Array.isArray(group.buckets)) {
        addBuckets(group.buckets, getNonEmptyString(group.displayName));
      }
    }
  }
  if (Array.isArray(buckets)) {
    addBuckets(buckets);
  }
  return [...pools.values()];
}

/** Parses `LanguageServerService/GetAvailableModels` payload to extract real per-model token limits from `agy.exe`. */
export function parseAvailableModelsPayload(payload: unknown): AvailableModelLimits[] {
  if (!isRecord(payload)) {
    return [];
  }
  const inner = isRecord(payload.response) ? payload.response : payload;
  if (!isRecord(inner.models)) {
    return [];
  }

  const parsed: AvailableModelLimits[] = [];
  for (const [modelKey, rawDetails] of Object.entries(inner.models)) {
    if (!isRecord(rawDetails)) {
      continue;
    }
    const maxTokens = getFiniteNumber(rawDetails.maxTokens);
    const maxOutputTokens = getFiniteNumber(rawDetails.maxOutputTokens);
    const modelId = getNonEmptyString(rawDetails.model);
    const displayName = getNonEmptyString(rawDetails.displayName);
    const quotaInfo = isRecord(rawDetails.quotaInfo) ? rawDetails.quotaInfo : undefined;
    const rawRemaining = quotaInfo !== undefined ? getFiniteNumber(quotaInfo.remainingFraction) : undefined;
    const resetTime = quotaInfo !== undefined ? getNonEmptyString(quotaInfo.resetTime) : undefined;
    const supportsThinking = typeof rawDetails.supportsThinking === 'boolean' ? rawDetails.supportsThinking : undefined;
    const supportsImages = typeof rawDetails.supportsImages === 'boolean' ? rawDetails.supportsImages : undefined;

    parsed.push({
      modelKey,
      ...(modelId !== undefined ? { modelId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
      ...(maxOutputTokens !== undefined && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
      ...(rawRemaining !== undefined ? { remainingFraction: clampFraction(rawRemaining) } : {}),
      ...(resetTime !== undefined ? { resetTime } : {}),
      ...(supportsThinking !== undefined ? { supportsThinking } : {}),
      ...(supportsImages !== undefined ? { supportsImages } : {}),
    });
  }
  return parsed;
}

function normalizeModelLookupKey(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mergeAvailableModelLimits(models: ModelQuotaInfo[], available: readonly AvailableModelLimits[]): void {
  const unmatched = new Set<AvailableModelLimits>(available);

  for (const quotaModel of models) {
    const exactId = quotaModel.modelId.trim().toLowerCase();
    const exactLabel = quotaModel.label.trim().toLowerCase();
    const baseLabel = normalizeModelLookupKey(quotaModel.label);

    const match =
      available.find(
        (entry) =>
          entry.modelKey.trim().toLowerCase() === exactId ||
          entry.modelId?.trim().toLowerCase() === exactId ||
          entry.displayName?.trim().toLowerCase() === exactLabel ||
          entry.modelKey.trim().toLowerCase() === exactLabel,
      ) ??
      available.find((entry) => {
        const displayBase = entry.displayName !== undefined ? normalizeModelLookupKey(entry.displayName) : undefined;
        const keyBase = normalizeModelLookupKey(entry.modelKey);
        return (displayBase !== undefined && displayBase === baseLabel) || keyBase === baseLabel;
      });

    if (match === undefined) {
      continue;
    }
    unmatched.delete(match);
    if (match.maxTokens !== undefined && match.maxTokens > 0) {
      quotaModel.maxTokens = match.maxTokens;
    }
    if (match.maxOutputTokens !== undefined && match.maxOutputTokens > 0) {
      quotaModel.maxOutputTokens = match.maxOutputTokens;
    }
  }

  for (const extra of unmatched) {
    if (extra.maxTokens === undefined && extra.maxOutputTokens === undefined) {
      continue;
    }
    const id = extra.modelId ?? extra.modelKey;
    const label = extra.displayName ?? extra.modelKey;
    models.push({
      label,
      modelId: id,
      remainingFraction: extra.remainingFraction ?? 1,
      ...(extra.resetTime !== undefined ? { resetTime: extra.resetTime } : {}),
      ...(extra.supportsThinking !== undefined ? { supportsThinking: extra.supportsThinking } : {}),
      ...(extra.supportsImages !== undefined ? { supportsImages: extra.supportsImages } : {}),
      ...(extra.maxTokens !== undefined ? { maxTokens: extra.maxTokens } : {}),
      ...(extra.maxOutputTokens !== undefined ? { maxOutputTokens: extra.maxOutputTokens } : {}),
    });
  }
}

/**
 * Parses a raw `LanguageServerService/GetUserStatus` JSON payload into an `AccountQuotaSnapshot`.
 */
export function parseGetUserStatusPayload(
  raw: unknown,
  source: 'acp-http' | 'daemon-hub',
  nowMs?: number,
): AccountQuotaSnapshot {
  const fetchedAt = nowMs ?? Date.now();
  if (!isRecord(raw)) {
    return createEmptySnapshot('error', fetchedAt, 'Invalid GetUserStatus response payload.');
  }

  if (typeof raw.code === 'string' && !isRecord(raw.userStatus)) {
    const code = raw.code.toLowerCase();
    if (code.includes('unauthenticated')) {
      return createEmptySnapshot('unauthenticated', fetchedAt);
    }
    const msg = getNonEmptyString(raw.message) ?? `GetUserStatus returned error code: ${raw.code}`;
    return createEmptySnapshot('error', fetchedAt, msg);
  }

  const userStatus = isRecord(raw.userStatus) ? raw.userStatus : raw;
  const email = getNonEmptyString(userStatus.email);
  const displayName = getNonEmptyString(userStatus.name);
  const userTier = isRecord(userStatus.userTier) ? userStatus.userTier : undefined;
  const tierId = userTier !== undefined ? getNonEmptyString(userTier.id) : undefined;
  const tierName = userTier !== undefined ? getNonEmptyString(userTier.name) : undefined;
  const profilePictureUrl =
    getNonEmptyString(userStatus.profilePictureUrl) ?? getNonEmptyString(userStatus.profilePicture);

  const planStatus = isRecord(userStatus.planStatus) ? userStatus.planStatus : undefined;
  const planInfo = planStatus !== undefined && isRecord(planStatus.planInfo) ? planStatus.planInfo : undefined;
  const availablePromptCredits =
    planStatus !== undefined ? getFiniteNumber(planStatus.availablePromptCredits) : undefined;
  const monthlyPromptCredits = planInfo !== undefined ? getFiniteNumber(planInfo.monthlyPromptCredits) : undefined;
  const availableFlowCredits = planStatus !== undefined ? getFiniteNumber(planStatus.availableFlowCredits) : undefined;
  const monthlyFlowCredits = planInfo !== undefined ? getFiniteNumber(planInfo.monthlyFlowCredits) : undefined;

  const cascadeModelConfigData = isRecord(userStatus.cascadeModelConfigData)
    ? userStatus.cascadeModelConfigData
    : undefined;
  const rawConfigs =
    cascadeModelConfigData !== undefined && Array.isArray(cascadeModelConfigData.clientModelConfigs)
      ? cascadeModelConfigData.clientModelConfigs
      : [];

  const models: ModelQuotaInfo[] = [];
  for (const item of rawConfigs) {
    if (!isRecord(item)) {
      continue;
    }
    const rawLabel = getNonEmptyString(item.label);
    const modelOrAlias = isRecord(item.modelOrAlias) ? item.modelOrAlias : undefined;
    const rawModelId =
      (modelOrAlias !== undefined ? getNonEmptyString(modelOrAlias.model) : undefined) ??
      (modelOrAlias !== undefined ? getNonEmptyString(modelOrAlias.alias) : undefined) ??
      getNonEmptyString(item.modelId) ??
      getNonEmptyString(item.model) ??
      rawLabel;

    if (rawModelId === undefined && rawLabel === undefined) {
      continue;
    }

    const modelId = rawModelId ?? rawLabel ?? '';
    const label = rawLabel ?? modelId;

    const quotaInfo = isRecord(item.quotaInfo) ? item.quotaInfo : undefined;
    const resetTime = quotaInfo !== undefined ? getNonEmptyString(quotaInfo.resetTime) : undefined;
    const rawRemaining = quotaInfo !== undefined ? getFiniteNumber(quotaInfo.remainingFraction) : undefined;

    let remainingFraction = 1;
    if (rawRemaining !== undefined) {
      remainingFraction = clampFraction(rawRemaining);
    } else if (quotaInfo !== undefined && resetTime !== undefined) {
      remainingFraction = 0;
    }

    const supportsThinking = typeof item.supportsThinking === 'boolean' ? item.supportsThinking : undefined;
    const supportsImages =
      typeof item.supportsImages === 'boolean' ? item.supportsImages : inferSupportsImages(item.supportedMimeTypes);
    const maxTokens = getFiniteNumber(item.maxTokens);
    const maxOutputTokens = getFiniteNumber(item.maxOutputTokens);

    models.push({
      label,
      modelId,
      description: getNonEmptyString(item.description),
      remainingFraction,
      resetTime,
      supportsThinking,
      supportsImages,
      ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
      ...(maxOutputTokens !== undefined && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    });
  }

  const signedIn = email !== undefined;
  const pools = clusterModelQuotas(models);

  return {
    signedIn,
    email,
    displayName,
    tierId,
    tierName,
    profilePictureUrl,
    availablePromptCredits,
    monthlyPromptCredits,
    availableFlowCredits,
    monthlyFlowCredits,
    models,
    pools,
    fetchedAt,
    source: signedIn ? source : 'unauthenticated',
  };
}

/**
 * Manages Antigravity account and model quota queries via ACP HTTP and daemon hub cold-start fallback.
 */
export class AgyQuotaService implements QuotaServiceInterface, vscode.Disposable {
  private readonly backend: AcpBackendInterface;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly daemonDir: string;
  private readonly snapshotEmitter: vscode.EventEmitter<AccountQuotaSnapshot> =
    new vscode.EventEmitter<AccountQuotaSnapshot>();
  private readonly backendStateSubscription: vscode.Disposable;

  public readonly onDidChangeSnapshot: vscode.Event<AccountQuotaSnapshot> = this.snapshotEmitter.event;

  private currentSnapshot: AccountQuotaSnapshot = createEmptySnapshot('unauthenticated', 0);
  private pollTimer: NodeJS.Timeout | undefined;
  private inFlightRefresh: Promise<AccountQuotaSnapshot> | undefined;
  private disposed = false;

  public constructor(backend: AcpBackendInterface, outputChannel: vscode.OutputChannel, daemonDir?: string) {
    this.backend = backend;
    this.outputChannel = outputChannel;
    this.daemonDir = daemonDir ?? path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
    this.backendStateSubscription = this.backend.onDidChangeBackendState((state) => {
      if (state.ready && !this.disposed) {
        void this.refresh();
      }
    });
  }

  public get latestSnapshot(): AccountQuotaSnapshot {
    return this.currentSnapshot;
  }

  public async refresh(force = false): Promise<AccountQuotaSnapshot> {
    if (this.disposed) {
      return this.currentSnapshot;
    }

    if (!force && this.inFlightRefresh !== undefined) {
      return await this.inFlightRefresh;
    }

    const refreshPromise = this.performRefresh();
    this.inFlightRefresh = refreshPromise;

    try {
      const next = await refreshPromise;
      if (!this.isDisposed()) {
        const changed = !snapshotsEqual(this.currentSnapshot, next);
        this.currentSnapshot = next;
        if (changed) {
          this.snapshotEmitter.fire(next);
        }
      }
      return next;
    } finally {
      if (this.inFlightRefresh === refreshPromise) {
        this.inFlightRefresh = undefined;
      }
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  public getModelQuota(modelId: string): ModelQuotaInfo | undefined {
    const exactMatch = this.currentSnapshot.models.find((model) => model.modelId === modelId);
    if (exactMatch !== undefined) {
      return exactMatch;
    }
    return this.currentSnapshot.models.find((model) => model.label === modelId);
  }

  public startPolling(intervalSec: number): void {
    this.stopPolling();
    if (this.disposed) {
      return;
    }
    const clampedSec = Math.max(1, intervalSec);
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, clampedSec * 1000);
    this.pollTimer.unref();
  }

  public stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopPolling();
    this.backendStateSubscription.dispose();
    this.snapshotEmitter.dispose();
  }

  private async performRefresh(): Promise<AccountQuotaSnapshot> {
    let acpHttpError: string | undefined;

    const port = this.backend.internalHttpPort;
    const csrfToken = this.backend.csrfToken;
    if (port !== undefined && port > 0 && csrfToken.length > 0) {
      try {
        return await this.fetchGetUserStatus(port, csrfToken, 'acp-http');
      } catch (error: unknown) {
        acpHttpError = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[QuotaService] acp-http GetUserStatus failed: ${acpHttpError}`);
      }
    }

    const hubs = await this.discoverAliveDaemonHubs();
    for (const hub of hubs) {
      try {
        return await this.fetchGetUserStatus(hub.httpPort, hub.csrfToken, 'daemon-hub');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[QuotaService] daemon-hub (pid=${hub.pid}) GetUserStatus failed: ${msg}`);
      }
    }

    if (acpHttpError !== undefined) {
      return createEmptySnapshot('error', Date.now(), acpHttpError);
    }

    return createEmptySnapshot('unauthenticated', Date.now());
  }

  private async fetchGetUserStatus(
    port: number,
    csrfToken: string,
    source: 'acp-http' | 'daemon-hub',
  ): Promise<AccountQuotaSnapshot> {
    const url = `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrfToken,
        },
        body: JSON.stringify({ metadata: {} }),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown;
      if (text.trim().length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return createEmptySnapshot('unauthenticated', Date.now());
        }
        if (parsed !== undefined) {
          const errorSnapshot = parseGetUserStatusPayload(parsed, source);
          if (errorSnapshot.source === 'unauthenticated' || errorSnapshot.source === 'error') {
            return errorSnapshot;
          }
        }
        throw new Error(`HTTP ${response.status} from GetUserStatus`);
      }

      const snapshot = parseGetUserStatusPayload(parsed ?? {}, source);
      if (snapshot.signedIn) {
        const [pools, availableLimits] = await Promise.all([
          this.fetchQuotaSummary(port, csrfToken),
          this.fetchAvailableModels(port, csrfToken),
        ]);
        if (pools.length > 0) {
          snapshot.pools = pools;
        }
        if (availableLimits.length > 0) {
          mergeAvailableModelLimits(snapshot.models, availableLimits);
        }
      }
      return snapshot;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchAvailableModels(port: number, csrfToken: string): Promise<AvailableModelLimits[]> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetAvailableModels`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrfToken,
          },
          body: '{}',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        },
      );
      return response.ok ? parseAvailableModelsPayload(await response.json()) : [];
    } catch {
      return [];
    }
  }

  private async fetchQuotaSummary(port: number, csrfToken: string): Promise<QuotaPoolSummary[]> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrfToken,
          },
          body: '{}',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        },
      );
      return response.ok ? parseQuotaSummary(await response.json()) : [];
    } catch {
      // Older local backends can still report per-model usage via GetUserStatus.
      return [];
    }
  }

  private async discoverAliveDaemonHubs(): Promise<HubDaemonInfo[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.daemonDir);
    } catch {
      return [];
    }

    const candidates: HubDaemonInfo[] = [];
    for (const entry of entries) {
      if (!HUB_FILE_PATTERN.test(entry)) {
        continue;
      }

      const fullPath = path.join(this.daemonDir, entry);
      try {
        const [stat, content] = await Promise.all([fs.stat(fullPath), fs.readFile(fullPath, 'utf8')]);
        const raw: unknown = JSON.parse(content);
        if (!isRecord(raw)) {
          continue;
        }

        const pid = getFiniteNumber(raw.pid);
        const httpPort = getFiniteNumber(raw.httpPort);
        const csrfToken = getNonEmptyString(raw.csrfToken);

        if (
          pid === undefined ||
          httpPort === undefined ||
          csrfToken === undefined ||
          httpPort <= 0 ||
          httpPort > 65535 ||
          !isPidAlive(pid)
        ) {
          continue;
        }

        candidates.push({
          pid,
          httpPort,
          csrfToken,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Ignore unreadable or malformed hub files during cold-start fallback scan.
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates;
  }
}
