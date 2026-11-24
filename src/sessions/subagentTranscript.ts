import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpToolCallUpdatePayload } from '../acp/acpTypes.js';
import type { AgyModelTokenTotal } from '../shared/contracts.js';
import { ANTIGRAVITY_SCHEME } from '../shared/contracts.js';

export const SUBAGENT_PATH_PREFIX = '/subagent/';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EFFORT_SUFFIX_RE = /\((?:low|medium|high|xhigh|max)\)\s*$/i;
const SUBAGENT_SYSTEM_MSG_WRAPPER_RE = /<SYSTEM_MESSAGE>[\s\S]*?\bcontent=([\s\S]*?)<\/SYSTEM_MESSAGE>/;

export interface SubagentCallMetadata {
  readonly typeName: string;
  readonly role: string;
  readonly prompt: string;
  readonly modelName: string | undefined;
  readonly conversationId: string | undefined;
  readonly isBrowser: boolean;
}

export interface SubagentTranscriptStepData {
  readonly stepKey: string;
  readonly toolName: string;
  readonly summary: string;
  readonly isComplete: boolean;
  readonly isError: boolean;
  readonly args: Record<string, unknown> | undefined;
  readonly modelName: string | undefined;
  readonly createdAtMs: number | undefined;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly markdownContent: string | undefined;
  readonly thinkingText: string | undefined;
  readonly isTerminalAssistantResponse?: boolean | undefined;
}

export interface LoadedSubagentTranscript {
  readonly title: string;
  readonly turns: (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[];
  readonly modelId: string | undefined;
  readonly details: string | undefined;
}

/**
 * Return whether an ACP tool call represents any Antigravity `invoke_subagent` invocation.
 */
export function isSubagentInvokeCall(update: AcpToolCallUpdatePayload): boolean {
  return (update.name ?? '').trim().toLowerCase() === 'invoke_subagent';
}

/**
 * Extract structured metadata for any `invoke_subagent` call (browser or general).
 */
export function extractSubagentCallMetadata(update: AcpToolCallUpdatePayload): SubagentCallMetadata {
  const input = update.args ?? update.rawInput;
  const rawOutput = update.rawOutput;

  const rawTypeName =
    getString(input, ['TypeName', 'typeName', 'type_name', 'subagent_type', 'subagentType', 'agent']) ?? '';
  const typeName = rawTypeName.trim();
  const isBrowser = typeName.toLowerCase() === 'browser';

  const role =
    getString(input, ['Role', 'role', 'agentDisplayName', 'Description', 'description', 'title']) ??
    update.title ??
    (isBrowser ? 'Browser Subagent' : typeName.length > 0 ? typeName : 'Subagent');

  const prompt = getString(input, ['Prompt', 'prompt', 'Task', 'task', 'instructions', 'query']) ?? update.title ?? '';

  const modelName =
    getString(input, ['Model', 'model', 'modelName', 'modelId']) ??
    getString(rawOutput, ['model', 'modelName', 'modelId']);

  const conversationId = extractConversationIdHint(input, rawOutput, update.locations);

  return {
    typeName: isBrowser ? 'Browser' : typeName.length > 0 ? typeName : 'Subagent',
    role: role.trim(),
    prompt: prompt.trim(),
    modelName: modelName !== undefined && modelName.trim().length > 0 ? modelName.trim() : undefined,
    conversationId,
    isBrowser,
  };
}

/**
 * Build the `antigravity:` subagent resource URI string for openable subagent sessions.
 */
export function buildSubagentChatResource(subagentId: string): string {
  return `${ANTIGRAVITY_SCHEME}:${SUBAGENT_PATH_PREFIX}${encodeURIComponent(subagentId)}`;
}

/**
 * Parse a subagent ID from either `antigravity:/subagent/<id>` or Workbench `?subagentChatResource=...`.
 */
export function parseSubagentIdFromResource(resource: vscode.Uri): string | undefined {
  const rawQuery = (resource as { readonly query?: string }).query;
  if (typeof rawQuery === 'string' && rawQuery.length > 0) {
    try {
      const subParam = new URLSearchParams(rawQuery).get('subagentChatResource');
      if (subParam !== null && subParam.length > 0) {
        const nested = vscode.Uri.parse(subParam);
        const nestedId = parseSubagentPathId(nested.path);
        if (nestedId !== undefined) {
          return nestedId;
        }
      }
    } catch {
      // Ignore malformed subagentChatResource query params.
    }
  }
  return parseSubagentPathId(resource.path);
}

/**
 * Format response footer model details cleanly without duplicating an existing effort suffix.
 */
export function formatResponseDetails(modelDisplayName?: string, thoughtLevel?: string): string | undefined {
  const base = modelDisplayName?.trim() ?? '';
  if (base.length === 0) {
    return undefined;
  }
  const normalizedEffort = thoughtLevel?.trim().toLowerCase() ?? '';
  if (normalizedEffort.length === 0 || EFFORT_SUFFIX_RE.test(base)) {
    return base;
  }
  const effortLabel = formatEffortDisplayLabel(normalizedEffort);
  return effortLabel !== undefined ? `${base} (${effortLabel})` : base;
}

/**
 * Summarize an arbitrary tool call in a subagent transcript for compact step display.
 */
export function formatSubagentToolSummary(
  toolName: string,
  args: Record<string, unknown> | undefined,
  fallbackText?: string,
): string {
  const lower = toolName.toLowerCase();
  if (args !== undefined) {
    const command = getString(args, ['CommandLine', 'commandLine', 'command', 'cmd']);
    if (command !== undefined) {
      return `Run ${truncateOneLine(command, 60)}`;
    }
    const filePath = getString(args, [
      'Path',
      'path',
      'AbsolutePath',
      'absolutePath',
      'filePath',
      'TargetFile',
      'file',
    ]);
    if (filePath !== undefined) {
      const label = path.basename(filePath.replace(/\\/g, '/')) || filePath;
      return `${formatToolVerb(lower)} ${label}`;
    }
    const query = getString(args, ['Query', 'query', 'Pattern', 'pattern', 'url', 'Url', 'TaskName', 'taskName']);
    if (query !== undefined) {
      return `${formatToolVerb(lower)}: ${truncateOneLine(query, 60)}`;
    }
  }
  if (fallbackText !== undefined && fallbackText.trim().length > 0) {
    return `${toolName}: ${truncateOneLine(fallbackText, 72)}`;
  }
  return toolName;
}

/**
 * Parse one JSONL record from a general subagent `transcript.jsonl` file.
 */
export function parseGeneralTranscriptRecord(
  rawParsed: Record<string, unknown>,
  nextSequence: () => number,
): SubagentTranscriptStepData[] {
  const stepIndex = getNumber(rawParsed, 'step_index');
  const statusStr = getString(rawParsed, ['status']);
  const isComplete =
    statusStr !== 'PENDING' && statusStr !== 'IN_PROGRESS' && statusStr !== 'pending' && statusStr !== 'in_progress';
  const isError = statusStr === 'ERROR' || statusStr === 'FAILED' || statusStr === 'error' || statusStr === 'failed';
  const stepType = getString(rawParsed, ['type']) ?? '';
  const sourceStr = getString(rawParsed, ['source']) ?? '';
  const createdAtRaw = getString(rawParsed, ['created_at', 'createdAt', 'timestamp']);
  const createdAtMs = parseTimestampMs(createdAtRaw);
  const modelName = getString(rawParsed, ['model', 'modelId', 'model_name']);

  const inputTokens = Math.max(0, Math.round(getNumber(rawParsed, 'input_tokens') ?? 0));
  const cachedTokens = Math.max(0, Math.round(getNumber(rawParsed, 'cache_read_tokens') ?? 0));
  const rawOutputTokens = getNumber(rawParsed, 'output_tokens');
  const outputTokens = Math.max(0, Math.round(rawOutputTokens ?? 0));

  const thinkingText = getString(rawParsed, ['thinking', 'thought']);
  const textContent = getString(rawParsed, ['content', 'text', 'message']);
  const allowAssistantMarkdown = isAssistantMessageRecord(stepType, sourceStr);

  const rawToolCalls = Array.isArray(rawParsed.tool_calls)
    ? rawParsed.tool_calls
    : Array.isArray(rawParsed.toolCalls)
      ? rawParsed.toolCalls
      : undefined;
  const hasToolCalls = rawToolCalls !== undefined && rawToolCalls.length > 0;
  const isTerminalAssistantResponse =
    allowAssistantMarkdown &&
    stepType.trim().toUpperCase() === 'PLANNER_RESPONSE' &&
    isComplete &&
    !hasToolCalls &&
    textContent !== undefined &&
    textContent.trim().length > 0;

  const steps: SubagentTranscriptStepData[] = [];
  if (rawToolCalls !== undefined && rawToolCalls.length > 0) {
    let attachedMeta = false;
    for (const rawTool of rawToolCalls) {
      if (!isRecord(rawTool)) {
        continue;
      }
      const toolName = getString(rawTool, ['name', 'tool']) ?? 'tool';
      const argsObj = parseArgsRecord(rawTool.arguments ?? rawTool.args ?? rawTool.rawInput ?? rawTool.input);
      const explicitId = getString(rawTool, ['id', 'toolCallId']);
      const seq = nextSequence();
      const stepKey = explicitId ?? `step-${stepIndex ?? seq}-${seq}`;
      const summary = formatSubagentToolSummary(toolName, argsObj);
      steps.push({
        stepKey,
        toolName,
        summary,
        isComplete,
        isError,
        args: argsObj,
        modelName: attachedMeta ? undefined : modelName,
        createdAtMs,
        inputTokens: attachedMeta ? 0 : inputTokens,
        cachedTokens: attachedMeta ? 0 : cachedTokens,
        outputTokens: attachedMeta ? 0 : outputTokens,
        markdownContent: !attachedMeta && allowAssistantMarkdown ? textContent : undefined,
        thinkingText: attachedMeta ? undefined : thinkingText,
      });
      attachedMeta = true;
    }
    if (steps.length > 0) {
      return steps;
    }
  }

  const directName = getString(rawParsed, ['tool', 'name', 'action']);
  if (directName !== undefined && directName.length > 0) {
    const seq = nextSequence();
    const explicitId = getString(rawParsed, ['id', 'toolCallId']);
    const argsObj = parseArgsRecord(rawParsed.arguments ?? rawParsed.args ?? rawParsed.input);
    const summary = getString(rawParsed, ['summary']) ?? formatSubagentToolSummary(directName, argsObj, textContent);
    return [
      {
        stepKey: explicitId ?? `step-${stepIndex ?? seq}-${seq}`,
        toolName: directName,
        summary,
        isComplete,
        isError,
        args: argsObj,
        modelName,
        createdAtMs,
        inputTokens,
        cachedTokens,
        outputTokens,
        markdownContent: undefined,
        thinkingText,
      },
    ];
  }

  if (
    allowAssistantMarkdown ||
    (thinkingText !== undefined && thinkingText.trim().length > 0) ||
    inputTokens > 0 ||
    outputTokens > 0
  ) {
    const seq = nextSequence();
    return [
      {
        stepKey: `msg-${stepIndex ?? seq}-${seq}`,
        toolName: '',
        summary: '',
        isComplete,
        isError,
        args: undefined,
        modelName,
        createdAtMs,
        inputTokens,
        cachedTokens,
        outputTokens,
        markdownContent: allowAssistantMarkdown ? textContent : undefined,
        thinkingText,
        isTerminalAssistantResponse,
      },
    ];
  }

  return [];
}

/**
 * Load a subagent's local `transcript.jsonl` as a VS Code chat session history when present.
 */
export function loadSubagentTranscriptHistory(
  subagentId: string,
  brainRootDir?: string,
): LoadedSubagentTranscript | undefined {
  const root = brainRootDir ?? path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const transcriptPath = path.join(root, subagentId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }

  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  let requestPrompt = '';
  const responseParts: vscode.ChatResponseTurn2['response'][number][] = [];
  const totalsByModel = new Map<
    string,
    { model: string; inputTokens: number; cachedTokens: number; outputTokens: number }
  >();
  let latestModel: string | undefined;
  let lastInputTokens = 0;
  let lastOutputTokens = 0;
  let earliestMs: number | undefined;
  let latestMs: number | undefined;
  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  for (const rawLine of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const stepType = getString(parsed, ['type']) ?? '';
    const source = getString(parsed, ['source']) ?? '';
    const createdAtMs = parseTimestampMs(getString(parsed, ['created_at', 'createdAt', 'timestamp']));
    if (createdAtMs !== undefined) {
      earliestMs = earliestMs === undefined ? createdAtMs : Math.min(earliestMs, createdAtMs);
      latestMs = latestMs === undefined ? createdAtMs : Math.max(latestMs, createdAtMs);
    }

    if (
      requestPrompt.length === 0 &&
      (stepType === 'SYSTEM_MESSAGE' || source === 'SYSTEM' || source.toUpperCase().startsWith('USER'))
    ) {
      const rawMsg = getString(parsed, ['content', 'text', 'message']) ?? '';
      requestPrompt = extractSubagentRequestPrompt(rawMsg);
      continue;
    }

    if (source.toUpperCase().startsWith('USER')) {
      continue;
    }

    const records = parseGeneralTranscriptRecord(parsed, nextSeq);
    for (const rec of records) {
      if (rec.modelName !== undefined) {
        latestModel = rec.modelName;
      }
      if (rec.inputTokens > 0 || rec.cachedTokens > 0 || rec.outputTokens > 0) {
        const modelKey = rec.modelName ?? latestModel ?? 'Antigravity';
        lastInputTokens = rec.inputTokens;
        lastOutputTokens = rec.outputTokens;
        const acc = totalsByModel.get(modelKey) ?? {
          model: modelKey,
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
        };
        acc.inputTokens += rec.inputTokens;
        acc.cachedTokens += rec.cachedTokens;
        acc.outputTokens += rec.outputTokens;
        totalsByModel.set(modelKey, acc);
      }

      if (rec.thinkingText !== undefined && rec.thinkingText.trim().length > 0) {
        responseParts.push(
          new vscode.ChatResponseThinkingProgressPart(
            rec.thinkingText,
          ) as unknown as vscode.ChatResponseTurn2['response'][number],
        );
      }

      if (rec.toolName.length > 0) {
        const toolPart = new vscode.ChatToolInvocationPart(rec.toolName, rec.stepKey);
        toolPart.invocationMessage = rec.summary;
        toolPart.pastTenseMessage = rec.summary;
        toolPart.isComplete = rec.isComplete;
        toolPart.isError = rec.isError;
        if (rec.isComplete && !rec.isError) {
          toolPart.isConfirmed = true;
        }
        responseParts.push(toolPart as unknown as vscode.ChatResponseTurn2['response'][number]);
      } else if (rec.markdownContent !== undefined && rec.markdownContent.trim().length > 0) {
        responseParts.push(new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(rec.markdownContent)));
      }
    }
  }

  const promptText = requestPrompt.length > 0 ? requestPrompt : `Subagent ${subagentId}`;
  const title = deriveShortTitle(promptText);
  const modelTotals: AgyModelTokenTotal[] = [...totalsByModel.values()];
  const details = latestModel !== undefined ? formatResponseDetails(latestModel) : undefined;
  const elapsedMs = earliestMs !== undefined && latestMs !== undefined ? Math.max(0, latestMs - earliestMs) : undefined;
  const completedAt = latestMs;

  if (
    lastInputTokens > 0 ||
    lastOutputTokens > 0 ||
    modelTotals.length > 0 ||
    details !== undefined ||
    elapsedMs !== undefined
  ) {
    const usagePayload = {
      used: lastInputTokens + lastOutputTokens,
      size: 0,
      ...(lastOutputTokens > 0 ? { completionTokens: lastOutputTokens } : {}),
      ...(modelTotals.length > 0 ? { modelTotals } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(details !== undefined ? { responseDetails: details } : {}),
    };
    const serialized = JSON.stringify(usagePayload).replaceAll('>', '\\u003e');
    responseParts.push(
      new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(`<!--AGY_USAGE:${serialized}-->`)),
    );
  }

  const turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [
    new vscode.ChatRequestTurn2(promptText, undefined, [], ANTIGRAVITY_SCHEME, [], undefined, undefined, latestModel),
    new vscode.ChatResponseTurn2(
      responseParts,
      details !== undefined ? ({ details } as unknown as vscode.ChatResult) : {},
      ANTIGRAVITY_SCHEME,
    ),
  ];

  return {
    title,
    turns,
    modelId: latestModel,
    details,
  };
}

function parseSubagentPathId(rawPath: string): string | undefined {
  if (!rawPath.startsWith(SUBAGENT_PATH_PREFIX)) {
    return undefined;
  }
  const rest = rawPath.slice(SUBAGENT_PATH_PREFIX.length).replace(/^\/+|\/+$/g, '');
  if (rest.length === 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

function extractConversationIdHint(
  input: Record<string, unknown> | undefined,
  rawOutput: Record<string, unknown> | undefined,
  locations: AcpToolCallUpdatePayload['locations'],
): string | undefined {
  const fromFields =
    getString(rawOutput, ['conversationId', 'conversation_id', 'ConversationId', 'subagentId', 'subagent_id', 'id']) ??
    getString(input, ['ConversationId', 'conversationId', 'conversation_id', 'subagentId', 'subagent_id']);
  if (fromFields !== undefined) {
    return fromFields.trim();
  }
  if (rawOutput !== undefined && Array.isArray(rawOutput.ConversationIds)) {
    const first: unknown = rawOutput.ConversationIds[0];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  if (locations !== undefined) {
    for (const loc of locations) {
      const normalized = loc.path.replace(/\\/g, '/');
      const idx = normalized.toLowerCase().lastIndexOf('/brain/');
      if (idx >= 0) {
        const afterBrain = normalized.slice(idx + '/brain/'.length).split('/')[0];
        if (afterBrain !== undefined && afterBrain.length > 0) {
          return afterBrain;
        }
      }
      const uuidMatch = UUID_RE.exec(normalized);
      if (uuidMatch !== null) {
        return uuidMatch[0];
      }
    }
  }
  return undefined;
}

function extractSubagentRequestPrompt(raw: string): string {
  const wrapped = SUBAGENT_SYSTEM_MSG_WRAPPER_RE.exec(raw);
  const candidate = wrapped?.[1] ?? raw;
  return candidate.trim();
}

function formatEffortDisplayLabel(effort: string): string | undefined {
  switch (effort) {
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'XHigh';
    case 'max':
      return 'Max';
    default:
      return undefined;
  }
}

function formatToolVerb(lowerTool: string): string {
  if (lowerTool.includes('read') || lowerTool.includes('view')) {
    return 'Read';
  }
  if (lowerTool.includes('edit') || lowerTool.includes('replace')) {
    return 'Edit';
  }
  if (lowerTool.includes('write') || lowerTool.includes('create')) {
    return 'Write';
  }
  if (lowerTool.includes('grep') || lowerTool.includes('search') || lowerTool.includes('find')) {
    return 'Search';
  }
  if (lowerTool.includes('list')) {
    return 'List';
  }
  return lowerTool;
}

function deriveShortTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('[Message]')) ?? text.trim();
  return truncateOneLine(line.length > 0 ? line : 'Subagent', 60);
}

function truncateOneLine(value: string, maxLen: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  if (single.length <= maxLen) {
    return single;
  }
  return `${single.slice(0, Math.max(0, maxLen - 3))}...`;
}

function parseTimestampMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function isAssistantMessageRecord(stepType: string, sourceStr: string): boolean {
  const upperSource = sourceStr.trim().toUpperCase();
  if (upperSource === 'SYSTEM' || upperSource.startsWith('USER')) {
    return false;
  }
  const upperType = stepType.trim().toUpperCase();
  return (
    upperType === '' ||
    upperType === 'PLANNER_RESPONSE' ||
    upperType === 'AGENT_MESSAGE' ||
    upperType === 'ASSISTANT_MESSAGE' ||
    upperType === 'TEXT' ||
    upperType === 'RESPONSE'
  );
}

function unwrapJsonQuotedString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const unquoted: unknown = JSON.parse(trimmed);
      if (typeof unquoted === 'string') {
        return unquoted;
      }
    } catch {
      return value;
    }
  }
  return value;
}

function unwrapArgsRecordStrings(record: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    normalized[key] = typeof val === 'string' ? unwrapJsonQuotedString(val) : val;
  }
  return normalized;
}

function parseArgsRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return unwrapArgsRecordStrings(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? unwrapArgsRecordStrings(parsed) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const val = record[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    }
  }
  return undefined;
}

function getNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (record === undefined) {
    return undefined;
  }
  const val = record[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}
