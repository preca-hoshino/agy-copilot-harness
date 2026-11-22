import type * as vscode from 'vscode';
import type { AgyContextWindowUsage, AgyTokenGroupUsage, ChatPromptTokenDetail } from '../shared/contracts.js';

interface MappedGroupDescriptor {
  readonly category: string;
  readonly label: string;
  readonly order: number;
}

interface AggregatedGroup {
  readonly category: string;
  readonly label: string;
  readonly order: number;
  numTokens: number;
}

const TOKEN_TYPE_DESCRIPTORS: Readonly<Record<string, MappedGroupDescriptor>> = {
  TOKEN_TYPE_SYSTEM_PROMPT: { category: 'System', label: 'System Instructions', order: 1 },
  TOKEN_TYPE_TOOLS: { category: 'System', label: 'Tool Definitions', order: 2 },
  TOKEN_TYPE_MCP_TOOLS: { category: 'System', label: 'MCP Tools', order: 3 },
  TOKEN_TYPE_RULES: { category: 'System', label: 'Rules', order: 4 },
  TOKEN_TYPE_SKILLS: { category: 'System', label: 'Skills', order: 5 },
  TOKEN_TYPE_SUBAGENTS: { category: 'System', label: 'Sub-agents', order: 6 },
  TOKEN_TYPE_PLUGINS: { category: 'System', label: 'Plugins', order: 7 },
  TOKEN_TYPE_WORKFLOWS: { category: 'System', label: 'Workflows', order: 8 },
  TOKEN_TYPE_FLOWS: { category: 'System', label: 'Flows', order: 9 },
  TOKEN_TYPE_CHAT_MESSAGES: { category: 'User Context', label: 'Messages', order: 100 },
};

const NAME_ALIAS_DESCRIPTORS: Readonly<Record<string, MappedGroupDescriptor>> = {
  'system prompt': { category: 'System', label: 'System Instructions', order: 1 },
  'system instructions': { category: 'System', label: 'System Instructions', order: 1 },
  tools: { category: 'System', label: 'Tool Definitions', order: 2 },
  'tool definitions': { category: 'System', label: 'Tool Definitions', order: 2 },
  'mcp tools': { category: 'System', label: 'MCP Tools', order: 3 },
  rules: { category: 'System', label: 'Rules', order: 4 },
  skills: { category: 'System', label: 'Skills', order: 5 },
  subagents: { category: 'System', label: 'Sub-agents', order: 6 },
  'sub-agents': { category: 'System', label: 'Sub-agents', order: 6 },
  plugins: { category: 'System', label: 'Plugins', order: 7 },
  workflows: { category: 'System', label: 'Workflows', order: 8 },
  flows: { category: 'System', label: 'Flows', order: 9 },
  'chat messages': { category: 'User Context', label: 'Messages', order: 100 },
  messages: { category: 'User Context', label: 'Messages', order: 100 },
};

const PERCENTAGE_PRECISION_FACTOR = 10_000;

function resolveGroupDescriptor(group: AgyTokenGroupUsage): MappedGroupDescriptor {
  const byType = TOKEN_TYPE_DESCRIPTORS[group.type];
  if (byType !== undefined) {
    return byType;
  }

  const normalizedName = group.name.trim().toLowerCase();
  const byName = normalizedName.length > 0 ? NAME_ALIAS_DESCRIPTORS[normalizedName] : undefined;
  if (byName !== undefined) {
    return byName;
  }

  const category = group.source === 'TOKEN_SOURCE_USER' ? 'User Context' : 'System';
  const trimmedName = group.name.trim();
  const label = trimmedName.length > 0 ? trimmedName : 'Other';
  return {
    category,
    label,
    order: category === 'User Context' ? 110 : 20,
  };
}

function roundPercentage(value: number): number {
  return Math.round(value * PERCENTAGE_PRECISION_FACTOR) / PERCENTAGE_PRECISION_FACTOR;
}

/**
 * Convert `agy.exe` token groups into VS Code `PromptTokenDetail[]` normalized against the total used tokens.
 */
export function mapTokenGroupsToPromptDetails(
  usage: AgyContextWindowUsage,
  totalUsedOverride?: number,
): readonly ChatPromptTokenDetail[] {
  const aggregated = new Map<string, AggregatedGroup>();
  let groupTotal = 0;

  for (const group of usage.tokenGroups) {
    if (!Number.isFinite(group.numTokens) || group.numTokens <= 0) {
      continue;
    }
    const descriptor = resolveGroupDescriptor(group);
    const key = `${descriptor.category}\u0000${descriptor.label}`;
    const existing = aggregated.get(key);
    if (existing !== undefined) {
      existing.numTokens += group.numTokens;
    } else {
      aggregated.set(key, {
        category: descriptor.category,
        label: descriptor.label,
        order: descriptor.order,
        numTokens: group.numTokens,
      });
    }
    groupTotal += group.numTokens;
  }

  if (groupTotal <= 0 || aggregated.size === 0) {
    return [];
  }

  const candidateTotal =
    totalUsedOverride !== undefined && Number.isFinite(totalUsedOverride) && totalUsedOverride > 0
      ? totalUsedOverride
      : usage.estimatedTokensUsed;
  const denominator = Math.max(groupTotal, Number.isFinite(candidateTotal) ? candidateTotal : 0);
  if (denominator <= 0) {
    return [];
  }

  const sorted = [...aggregated.values()].sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    if (right.numTokens !== left.numTokens) {
      return right.numTokens - left.numTokens;
    }
    return left.label.localeCompare(right.label);
  });

  const details: ChatPromptTokenDetail[] = sorted.map((entry) => ({
    category: entry.category,
    label: entry.label,
    percentageOfPrompt: roundPercentage((entry.numTokens / denominator) * 100),
  }));

  // Guard against floating-point rounding pushing the total slightly above 100%.
  let percentageSum = 0;
  let largestIndex = -1;
  let largestPercentage = -1;
  for (let i = 0; i < details.length; i += 1) {
    const entry = details[i];
    if (entry === undefined) {
      continue;
    }
    percentageSum += entry.percentageOfPrompt;
    if (entry.percentageOfPrompt > largestPercentage) {
      largestPercentage = entry.percentageOfPrompt;
      largestIndex = i;
    }
  }
  if (percentageSum > 100 && largestIndex >= 0) {
    const target = details[largestIndex];
    if (target !== undefined) {
      details[largestIndex] = {
        ...target,
        percentageOfPrompt: Math.max(0, roundPercentage(target.percentageOfPrompt - (percentageSum - 100))),
      };
    }
  }

  return details.filter((entry) => entry.percentageOfPrompt > 0);
}

/**
 * Build a VS Code `ChatResponseUsage` object from ACP usage totals and optional backend breakdown data.
 */
export function buildChatResponseUsage(params: {
  readonly totalUsed: number;
  readonly breakdown?: AgyContextWindowUsage | undefined;
}): vscode.ChatResponseUsage {
  const fallbackUsed = Number.isFinite(params.totalUsed) && params.totalUsed > 0 ? params.totalUsed : 0;
  const breakdown = params.breakdown;
  const effectiveUsed =
    breakdown !== undefined && Number.isFinite(breakdown.estimatedTokensUsed) && breakdown.estimatedTokensUsed > 0
      ? breakdown.estimatedTokensUsed
      : fallbackUsed;

  const rawCompletion = breakdown?.completionTokens;
  const completionTokens =
    rawCompletion !== undefined && Number.isFinite(rawCompletion) && rawCompletion > 0
      ? Math.min(effectiveUsed, rawCompletion)
      : 0;
  const promptTokens = Math.max(0, effectiveUsed - completionTokens);
  const promptTokenDetails = breakdown !== undefined ? mapTokenGroupsToPromptDetails(breakdown, effectiveUsed) : [];

  return {
    promptTokens,
    completionTokens,
    ...(promptTokenDetails.length > 0 ? { promptTokenDetails } : {}),
  };
}
