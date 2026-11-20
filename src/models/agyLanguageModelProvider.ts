import * as vscode from 'vscode';
import type { AcpConfigOption, AcpConfigOptionChoice } from '../acp/acpTypes.js';
import type { AcpBackendInterface, ModelQuotaInfo, QuotaServiceInterface } from '../shared/contracts.js';

export interface ResolvedModelSelection {
  readonly modelValue: string;
  readonly thoughtLevel: string;
}

const DEFAULT_EFFORT_VALUES: readonly string[] = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_EFFORT_LABELS: readonly string[] = ['Low', 'Medium', 'High', 'Extra'];
const VENDOR_PREFIXES: readonly string[] = ['antigravity/', 'antigravity:'];
const GPT_OSS_ID = 'gpt-oss-120b';
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra' } as const;
type Effort = keyof typeof EFFORT_LABELS;

interface EffortVariant {
  readonly model: AcpConfigOptionChoice;
  readonly effort: Effort;
}

interface ModelVariantGroup {
  readonly name: string;
  readonly variants: EffortVariant[];
}

interface TokenLimits {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxContextWindowTokens: number;
}

export class AgyLanguageModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly backend: AcpBackendInterface;
  private readonly quotaService: QuotaServiceInterface;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  public readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.onDidChangeEmitter.event;

  public constructor(backend: AcpBackendInterface, quotaService: QuotaServiceInterface) {
    this.backend = backend;
    this.quotaService = quotaService;

    this.disposables.push(
      this.quotaService.onDidChangeSnapshot(() => {
        this.onDidChangeEmitter.fire();
      }),
      this.backend.onDidChangeBackendState(() => {
        this.onDidChangeEmitter.fire();
      }),
      this.backend.onDidChangeUpdate((event) => {
        if (event.update.sessionUpdate === 'config_option_update') {
          this.onDidChangeEmitter.fire();
        }
      }),
    );
  }

  public provideLanguageModelChatInformation(
    _options: vscode.LanguageModelChatInformationOptions,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    const configOptions = this.backend.getLastKnownConfigOptions();
    const modelConfig = findConfigOption(configOptions, 'model');
    const thoughtConfig = findConfigOption(configOptions, 'thought_level');
    const currentThoughtLevel = resolveCurrentThoughtLevel(thoughtConfig);
    const snapshot = this.quotaService.latestSnapshot;

    const modelOptions = getModelChoices(modelConfig, snapshot.models);
    const currentModelValue = modelConfig?.currentValue ?? modelOptions[0]?.value;
    const groups = getModelVariantGroups(modelOptions);
    const published = new Set<string>();
    const results: vscode.LanguageModelChatInformation[] = [];
    for (const choice of modelOptions) {
      const entry = [...groups.entries()].find(([, group]) => group.variants.some(({ model }) => model === choice));
      const groupId = entry?.[0];
      const group = entry?.[1];
      if (groupId !== undefined && published.has(groupId)) {
        continue;
      }
      if (groupId !== undefined) {
        published.add(groupId);
      }
      const variants = group?.variants ?? [];
      const defaultVariant = selectModelVariant(variants, currentModelValue);
      const model = defaultVariant?.model ?? choice;
      const quotaInfo = this.findMatchingQuotaInfo(model.value, model.name, snapshot.models);
      results.push(
        this.buildModelInformation({
          id: groupId ?? model.value,
          name: group?.name ?? model.name,
          description: quotaInfo?.description ?? model.description,
          isDefault: choice.value === currentModelValue || variants.some((variant) => variant.model.value === currentModelValue),
          quotaInfo,
          thoughtConfig,
          currentThoughtLevel: defaultVariant?.effort ?? currentThoughtLevel,
          effortVariants: variants,
          signedIn: snapshot.signedIn,
        }),
      );
    }

    return results;
  }

  public async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    await Promise.resolve();
  }

  public async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    await Promise.resolve();
    const textLen = typeof text === 'string' ? text.length : measureMessageLength(text);
    return Math.ceil(textLen / 4);
  }

  public resolveModelAndEffort(
    selectedModelId: string | undefined,
    modelConfiguration?: Record<string, unknown>,
  ): ResolvedModelSelection {
    const configOptions = this.backend.getLastKnownConfigOptions();
    const modelConfig = findConfigOption(configOptions, 'model');
    const thoughtConfig = findConfigOption(configOptions, 'thought_level');
    const modelOptions = getModelChoices(modelConfig, this.quotaService.latestSnapshot.models);
    const modelValue = resolveModelValue(selectedModelId, modelConfig, modelOptions, this.quotaService);
    const groups = getModelVariantGroups(modelOptions);
    const group = groups.get(modelValue);
    if (group) {
      const variant = selectModelVariant(
        group.variants,
        modelConfig?.currentValue,
        modelConfiguration?.reasoningEffort,
      );
      if (variant) {
        // These ACP model IDs already select the effort; do not overwrite it with thought_level.
        return { modelValue: variant.model.value, thoughtLevel: '' };
      }
    }
    if ([...groups.values()].some(({ variants }) => variants.some((variant) => variant.model.value === modelValue))) {
      return { modelValue, thoughtLevel: '' };
    }
    const thoughtLevel = resolveThoughtLevel(modelConfiguration, thoughtConfig);

    return {
      modelValue,
      thoughtLevel,
    };
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.onDidChangeEmitter.dispose();
  }

  private findMatchingQuotaInfo(
    modelId: string,
    modelName: string,
    models: readonly ModelQuotaInfo[],
  ): ModelQuotaInfo | undefined {
    const direct = this.quotaService.getModelQuota(modelId);
    if (direct !== undefined) {
      return direct;
    }

    const normalizedId = modelId.toLowerCase();
    const normalizedName = modelName.toLowerCase();
    return models.find(
      (candidate) =>
        candidate.modelId.toLowerCase() === normalizedId || candidate.label.toLowerCase() === normalizedName,
    );
  }

  private buildModelInformation(params: {
    readonly id: string;
    readonly name: string;
    readonly description: string | undefined;
    readonly isDefault: boolean;
    readonly quotaInfo: ModelQuotaInfo | undefined;
    readonly thoughtConfig: AcpConfigOption | undefined;
    readonly currentThoughtLevel: string;
    readonly effortVariants: readonly EffortVariant[];
    readonly signedIn: boolean;
  }): vscode.LanguageModelChatInformation {
    const limits = inferTokenLimits(params.id, params.name);
    const family = inferModelFamily(params.id, params.name);
    const icon = MODEL_FAMILY_ICONS[family];
    const efforts = [...new Set(params.effortVariants.map((variant) => variant.effort))];
    const supportsThinking = inferSupportsThinking(params.id, params.name, params.quotaInfo, params.thoughtConfig);
    const tooltip = buildQuotaTooltip(params.name, params.id, params.description, params.quotaInfo, params.signedIn);
    const detail = buildModelDetail(params.description, params.quotaInfo);

    const baseInfo: vscode.LanguageModelChatInformation = {
      id: params.id,
      name: params.name,
      family,
      ...(icon ? { statusIcon: new vscode.ThemeIcon(icon) } : {}),
      version: '1.0.0',
      maxInputTokens: limits.maxInputTokens,
      maxOutputTokens: limits.maxOutputTokens,
      maxContextWindowTokens: limits.maxContextWindowTokens,
      tooltip,
      isUserSelectable: true,
      targetChatSessionType: 'antigravity',
      capabilities: {
        imageInput: true,
        toolCalling: true,
      },
      ...(detail !== undefined ? { detail } : {}),
      ...(params.isDefault ? { isDefault: true } : {}),
    };

    if (!supportsThinking && params.effortVariants.length === 0) {
      return baseInfo;
    }

    return {
      ...baseInfo,
      configurationSchema: {
        properties: {
          reasoningEffort: {
            type: 'string',
            title: 'Effort Level',
            enum: efforts.length ? efforts : [...DEFAULT_EFFORT_VALUES],
            enumItemLabels: efforts.length ? efforts.map((effort) => EFFORT_LABELS[effort]) : [...DEFAULT_EFFORT_LABELS],
            group: 'navigation',
            default: params.currentThoughtLevel,
          },
        },
      },
    };
  }
}

function getModelChoices(modelConfig: AcpConfigOption | undefined, models: readonly ModelQuotaInfo[]): AcpConfigOptionChoice[] {
  return modelConfig?.options.length
    ? modelConfig.options
    : models.map((model) => ({ value: model.modelId, name: model.label, description: model.description }));
}

const EFFORT_SUFFIX = /\s+\((low|medium|high|xhigh)\)$/i;

function getModelGroupId(name: string): string {
  return name.replace(EFFORT_SUFFIX, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
}

function getModelVariantGroups(choices: readonly AcpConfigOptionChoice[]): Map<string, ModelVariantGroup> {
  const groups = new Map<string, ModelVariantGroup>();
  const effortOrder = Object.keys(EFFORT_LABELS);
  for (const model of choices) {
    const suffix = EFFORT_SUFFIX.exec(model.name);
    const gptOssId = /^model_gpt_oss_120b_(low|medium|high)$/i.exec(model.value);
    const effort = (suffix?.[1] ?? gptOssId?.[1])?.toLowerCase() as Effort | undefined;
    if (!effort || (!gptOssId && !/^(claude|gemini|gpt[- ]oss 120b)\b/i.test(model.name))) {
      continue;
    }
    const baseId = gptOssId ? GPT_OSS_ID : getModelGroupId(model.name);
    const id = choices.some((choice) => choice.value === baseId) ? `${baseId}-effort` : baseId;
    const group = groups.get(id) ?? {
      name: baseId === GPT_OSS_ID ? 'GPT-OSS 120B' : model.name.replace(EFFORT_SUFFIX, ''),
      variants: [],
    };
    group.variants.push({ model, effort });
    groups.set(id, group);
  }
  for (const { variants } of groups.values()) {
    variants.sort((a, b) => effortOrder.indexOf(a.effort) - effortOrder.indexOf(b.effort));
  }
  return groups;
}

function selectModelVariant(
  variants: readonly EffortVariant[],
  currentModelValue: string | undefined,
  effort?: unknown,
): EffortVariant | undefined {
  return variants.find((variant) => variant.effort === effort)
    ?? variants.find((variant) => variant.model.value === currentModelValue)
    ?? variants.find((variant) => variant.effort === 'medium')
    ?? variants[0];
}

function findConfigOption(options: readonly AcpConfigOption[], id: string): AcpConfigOption | undefined {
  return options.find((opt) => opt.id === id);
}

function resolveCurrentThoughtLevel(thoughtConfig: AcpConfigOption | undefined): string {
  const current = thoughtConfig?.currentValue;
  if (current !== undefined && current.length > 0) {
    return current;
  }
  const firstOption = thoughtConfig?.options[0]?.value;
  if (firstOption !== undefined && firstOption.length > 0) {
    return firstOption;
  }
  return 'medium';
}

function resolveModelValue(
  selectedModelId: string | undefined,
  modelConfig: AcpConfigOption | undefined,
  modelOptions: readonly AcpConfigOptionChoice[],
  quotaService: QuotaServiceInterface,
): string {
  if (selectedModelId !== undefined && selectedModelId.length > 0) {
    const exactMatch = modelOptions.find((choice) => choice.value === selectedModelId);
    if (exactMatch !== undefined) {
      return exactMatch.value;
    }

    const stripped = stripVendorPrefix(selectedModelId);
    const strippedMatch = modelOptions.find((choice) => choice.value === stripped);
    if (strippedMatch !== undefined) {
      return strippedMatch.value;
    }

    return stripped;
  }

  const currentValue = modelConfig?.currentValue;
  if (currentValue !== undefined && currentValue.length > 0) {
    return currentValue;
  }

  const firstOption = modelOptions[0]?.value;
  if (firstOption !== undefined && firstOption.length > 0) {
    return firstOption;
  }

  const firstQuotaModel = quotaService.latestSnapshot.models[0]?.modelId;
  if (firstQuotaModel !== undefined && firstQuotaModel.length > 0) {
    return firstQuotaModel;
  }

  return '';
}

function stripVendorPrefix(modelId: string): string {
  for (const prefix of VENDOR_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      return modelId.slice(prefix.length);
    }
  }
  return modelId;
}

function resolveThoughtLevel(
  modelConfiguration: Record<string, unknown> | undefined,
  thoughtConfig: AcpConfigOption | undefined,
): string {
  if (modelConfiguration !== undefined) {
    const reasoningEffort = modelConfiguration.reasoningEffort;
    if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
      return reasoningEffort;
    }

    const effortLevel = modelConfiguration.effortLevel;
    if (typeof effortLevel === 'string' && effortLevel.length > 0) {
      return effortLevel;
    }
  }

  return resolveCurrentThoughtLevel(thoughtConfig);
}

function inferSupportsThinking(
  id: string,
  name: string,
  quotaInfo: ModelQuotaInfo | undefined,
  thoughtConfig: AcpConfigOption | undefined,
): boolean {
  if (quotaInfo?.supportsThinking !== undefined) {
    return quotaInfo.supportsThinking;
  }
  if (thoughtConfig !== undefined && thoughtConfig.options.length > 0) {
    return true;
  }
  return /think|reason|opus|sonnet|argon|neon|hydrogen|pro|claude|gemini|o1|o3|o4/i.test(`${id} ${name}`);
}

const MODEL_FAMILY_ICONS: Readonly<Record<string, string>> = {
  antigravity: 'antigravity-logo',
  claude: 'chat-model-provider-claude',
  gemini: 'chat-model-provider-gemini',
  gpt: 'chat-model-provider-openai',
};

function inferModelFamily(id: string, name: string): string {
  const combined = `${id} ${name}`.toLowerCase();
  if (/orchestrator|hive|蜂巢/.test(combined)) {
    return 'antigravity';
  }
  if (combined.includes('gemini') || combined.includes('argon') || combined.includes('neon')) {
    return 'gemini';
  }
  if (combined.includes('claude') || combined.includes('opus') || combined.includes('sonnet')) {
    return 'claude';
  }
  if (combined.includes('gpt')) {
    return 'gpt';
  }
  return 'antigravity';
}

function inferTokenLimits(id: string, name: string): TokenLimits {
  const combined = `${id} ${name}`.toLowerCase();
  if (combined.includes('gemini') || combined.includes('argon') || combined.includes('neon')) {
    return {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 65_536,
      maxContextWindowTokens: 1_048_576,
    };
  }
  if (combined.includes('claude') || combined.includes('opus') || combined.includes('sonnet')) {
    return {
      maxInputTokens: 200_000,
      maxOutputTokens: 32_768,
      maxContextWindowTokens: 200_000,
    };
  }
  return {
    maxInputTokens: 128_000,
    maxOutputTokens: 32_768,
    maxContextWindowTokens: 128_000,
  };
}

function buildModelDetail(description: string | undefined, quotaInfo: ModelQuotaInfo | undefined): string | undefined {
  if (quotaInfo !== undefined) {
    const remainingPercent = computeRemainingPercent(quotaInfo.remainingFraction);
    return `${remainingPercent}% left`;
  }
  if (description !== undefined && description.length > 0) {
    return description;
  }
  return undefined;
}

function buildQuotaTooltip(
  name: string,
  id: string,
  description: string | undefined,
  quotaInfo: ModelQuotaInfo | undefined,
  signedIn: boolean,
): string {
  if (description) {
    return description;
  }
  const lines: string[] = [`${name} (${id})`];

  if (quotaInfo !== undefined) {
    const remainingPercent = computeRemainingPercent(quotaInfo.remainingFraction);
    lines.push(`Remaining quota: ${remainingPercent}%`);
    if (quotaInfo.resetTime !== undefined && quotaInfo.resetTime.length > 0) {
      lines.push(`Reset time: ${formatResetTime(quotaInfo.resetTime)}`);
    }
  } else if (!signedIn) {
    lines.push('Sign in with Google Antigravity to view remaining quota.');
  } else {
    lines.push('Quota information unavailable.');
  }

  return lines.join('\n');
}

function computeRemainingPercent(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return Math.round(clamped * 100);
}

function formatResetTime(resetTime: string): string {
  const parsed = Date.parse(resetTime);
  if (Number.isNaN(parsed)) {
    return resetTime;
  }
  const formatted = new Date(parsed).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${formatted} (${resetTime})`;
}

function measureMessageLength(message: vscode.LanguageModelChatRequestMessage): number {
  let total = 0;
  for (const part of message.content) {
    if (typeof part === 'string') {
      total += part.length;
    } else if (part !== null && typeof part === 'object') {
      total += measureObjectPartLength(part);
    }
  }
  return total;
}

function measureObjectPartLength(part: object): number {
  const record = part as Record<string, unknown>;
  if (typeof record.value === 'string') {
    return record.value.length;
  }
  if (typeof record.text === 'string') {
    return record.text.length;
  }
  if (typeof record.content === 'string') {
    return record.content.length;
  }
  const serialized = JSON.stringify(part);
  return typeof serialized === 'string' ? serialized.length : 0;
}
