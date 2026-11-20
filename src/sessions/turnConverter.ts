import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  AcpContentBlock,
  AcpPlanUpdatePayload,
  AcpSessionUpdate,
  AcpToolCallContentDiff,
  AcpToolCallContentItem,
  AcpToolCallUpdatePayload,
} from '../acp/acpTypes.js';
import type { BrowserSubagentRenderer } from './browserSubagentRenderer.js';

export interface ConvertedHistory {
  readonly title?: string | undefined;
  readonly turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  readonly changes: vscode.ChatSessionFileChange[];
}

type ToolCallCategory = 'browser' | 'execute' | 'read' | 'edit' | 'generic';
type ResponsePart = vscode.ChatResponseTurn2['response'][number];

type ResponseTurnSlot =
  | { readonly kind: 'part'; readonly part: ResponsePart }
  | { readonly kind: 'plan'; entries: AcpPlanUpdatePayload['entries'] }
  | { readonly kind: 'tool'; readonly toolCallId: string };

interface MutableFileChange {
  readonly modifiedUri: vscode.Uri;
  originalUri: vscode.Uri | undefined;
  insertions: number;
  deletions: number;
}

const EXECUTE_TOOL_NAMES = new Set<string>([
  'run_command',
  'execute_command',
  'command',
  'bash',
  'sh',
  'pwsh',
  'powershell',
  'terminal',
]);

const READ_TOOL_NAMES = new Set<string>([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'read',
  'view',
  'get_file',
]);

const EDIT_TOOL_NAMES = new Set<string>([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'create_file',
  'patch_file',
  'apply_patch',
  'edit',
  'write',
]);

export class TurnConverter {
  private readonly browserRenderer: BrowserSubagentRenderer;
  private readonly sessionId: string;
  private readonly participantId: string;

  private title: string | undefined;
  private readonly turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
  private readonly toolCallsById = new Map<string, AcpToolCallUpdatePayload>();
  private readonly orderedToolCallIds: string[] = [];

  private pendingUserPrompt = '';
  // The history bridge uses the reference name as the attachment label.
  private pendingUserReferences: Array<vscode.ChatPromptReference & { name: string }> = [];
  private hasPendingUserTurn = false;

  private thinkingBuffer = '';
  private markdownBuffer = '';
  private currentTurnSlots: ResponseTurnSlot[] = [];
  private readonly currentTurnToolIds = new Set<string>();

  public constructor(
    browserRenderer: BrowserSubagentRenderer,
    sessionId: string,
    participantId?: string,
    private readonly attachmentDir?: string,
  ) {
    this.browserRenderer = browserRenderer;
    this.sessionId = sessionId;
    this.participantId = participantId ?? 'antigravity';
  }

  public processUpdate(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        if (isMessageChunkPayload(update)) {
          this.handleUserMessageChunk(update.content);
        }
        break;
      }
      case 'agent_thought_chunk': {
        if (isMessageChunkPayload(update)) {
          this.handleAgentThoughtChunk(update.content);
        }
        break;
      }
      case 'agent_message_chunk': {
        if (isMessageChunkPayload(update)) {
          this.handleAgentMessageChunk(update.content);
        }
        break;
      }
      case 'plan': {
        if (isPlanUpdatePayload(update)) {
          this.handlePlanUpdate(update);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (isToolCallUpdatePayload(update)) {
          this.handleToolCallUpdate(update);
        }
        break;
      }
      default:
        break;
    }
  }

  public finalizeHistory(): ConvertedHistory {
    this.flushPendingUserTurn();
    this.flushCurrentResponseTurn();

    const aggregatedChanges = new Map<string, MutableFileChange>();
    for (const toolCallId of this.orderedToolCallIds) {
      const merged = this.toolCallsById.get(toolCallId);
      if (merged === undefined) {
        continue;
      }
      if (classifyToolCall(merged, this.browserRenderer) !== 'edit') {
        continue;
      }
      for (const change of extractFileChangesFromToolCall(merged)) {
        accumulateFileChange(aggregatedChanges, change);
      }
    }

    const changes: vscode.ChatSessionFileChange[] = [];
    for (const item of aggregatedChanges.values()) {
      changes.push({
        modifiedUri: item.modifiedUri,
        ...(item.originalUri !== undefined ? { originalUri: item.originalUri } : {}),
        insertions: item.insertions,
        deletions: item.deletions,
      });
    }

    return {
      title: this.title,
      turns: [...this.turns],
      changes,
    };
  }

  private handleUserMessageChunk(content: AcpContentBlock): void {
    if (this.hasActiveResponseContent()) {
      this.flushCurrentResponseTurn();
    }

    this.hasPendingUserTurn = true;
    if (content.type === 'text') {
      this.pendingUserPrompt += content.text ?? '';
      return;
    }
    const attachment = resolveMessageAttachment(content, this.attachmentDir);
    if (attachment && !this.pendingUserReferences.some((ref) => ref.id === attachment.id)) {
      this.pendingUserReferences.push({ id: attachment.id, name: attachment.name, value: attachment.uri });
    }
  }

  private handleAgentThoughtChunk(content: AcpContentBlock): void {
    this.flushPendingUserTurn();
    this.flushMarkdownBuffer();
    const chunkText = extractContentBlockText(content);
    if (chunkText.length > 0) {
      this.thinkingBuffer += chunkText;
    }
  }

  private handleAgentMessageChunk(content: AcpContentBlock): void {
    this.flushPendingUserTurn();
    this.flushThinkingBuffer();
    const part = buildStandaloneAgentMessagePart(content, this.attachmentDir);
    if (part !== undefined) {
      this.flushMarkdownBuffer();
      this.currentTurnSlots.push({ kind: 'part', part });
      return;
    }
    const chunkText = extractContentBlockText(content);
    if (chunkText.length > 0) {
      this.markdownBuffer += chunkText;
    }
  }

  private handlePlanUpdate(update: AcpPlanUpdatePayload): void {
    this.flushPendingUserTurn();
    this.flushThinkingBuffer();
    this.flushMarkdownBuffer();

    const existingPlanSlot = this.currentTurnSlots.find(
      (slot): slot is Extract<ResponseTurnSlot, { readonly kind: 'plan' }> => slot.kind === 'plan',
    );
    if (existingPlanSlot !== undefined) {
      existingPlanSlot.entries = update.entries;
      return;
    }
    this.currentTurnSlots.push({ kind: 'plan', entries: update.entries });
  }

  private handleToolCallUpdate(update: AcpToolCallUpdatePayload): void {
    this.flushPendingUserTurn();
    this.flushThinkingBuffer();
    this.flushMarkdownBuffer();

    const previous = this.toolCallsById.get(update.toolCallId);
    const merged = mergeToolCallUpdate(previous, update);
    if (previous === undefined) {
      this.orderedToolCallIds.push(update.toolCallId);
    }
    this.toolCallsById.set(update.toolCallId, merged);

    if (!this.currentTurnToolIds.has(update.toolCallId)) {
      this.currentTurnToolIds.add(update.toolCallId);
      this.currentTurnSlots.push({ kind: 'tool', toolCallId: update.toolCallId });
    }
  }

  private hasActiveResponseContent(): boolean {
    return this.thinkingBuffer.length > 0 || this.markdownBuffer.length > 0 || this.currentTurnSlots.length > 0;
  }

  private flushPendingUserTurn(): void {
    if (!this.hasPendingUserTurn) {
      return;
    }
    const promptText = this.pendingUserPrompt;
    const refs = this.pendingUserReferences;
    this.pendingUserPrompt = '';
    this.pendingUserReferences = [];
    this.hasPendingUserTurn = false;

    if (this.title === undefined && promptText.trim().length > 0) {
      this.title = deriveSessionTitle(promptText);
    }

    this.turns.push(new vscode.ChatRequestTurn2(promptText, undefined, refs, this.participantId));
  }

  private flushThinkingBuffer(): void {
    if (this.thinkingBuffer.length === 0) {
      return;
    }
    const part = new vscode.ChatResponseThinkingProgressPart(this.thinkingBuffer);
    this.thinkingBuffer = '';
    this.currentTurnSlots.push({
      kind: 'part',
      part: part as unknown as vscode.ChatResponsePart,
    });
  }

  private flushMarkdownBuffer(): void {
    if (this.markdownBuffer.length === 0) {
      return;
    }
    const part = new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(this.markdownBuffer));
    this.markdownBuffer = '';
    this.currentTurnSlots.push({
      kind: 'part',
      part,
    });
  }

  private flushCurrentResponseTurn(): void {
    this.flushThinkingBuffer();
    this.flushMarkdownBuffer();

    if (this.currentTurnSlots.length === 0) {
      return;
    }

    const parts: ResponsePart[] = [];
    for (const slot of this.currentTurnSlots) {
      if (slot.kind === 'part') {
        parts.push(slot.part);
      } else if (slot.kind === 'plan') {
        const planPart = buildPlanToolPart(slot.entries, `plan-${this.sessionId}`);
        parts.push(planPart as unknown as vscode.ChatResponsePart);
      } else {
        const merged = this.toolCallsById.get(slot.toolCallId);
        if (merged === undefined) {
          continue;
        }
        if (this.browserRenderer.isBrowserSubagentCall(merged)) {
          const browserParts = this.browserRenderer.renderReplayToolCall(merged, this.sessionId);
          for (const browserPart of browserParts) {
            parts.push(browserPart);
          }
        } else {
          const toolPart = buildToolInvocationPart(merged, true);
          parts.push(toolPart as unknown as vscode.ChatResponsePart);
        }
      }
    }

    this.currentTurnSlots = [];
    this.currentTurnToolIds.clear();

    this.turns.push(new vscode.ChatResponseTurn2(parts, {}, this.participantId));
  }
}

export class LiveStreamAdapter {
  private readonly browserRenderer: BrowserSubagentRenderer;
  private readonly sessionId: string;
  private readonly stream: Pick<vscode.ChatResponseStream, 'push'>;
  private readonly onFileChange: (change: vscode.ChatSessionFileChange) => void;
  private readonly onNeedsInput: ((reason: string) => void) | undefined;

  private readonly toolCallsById = new Map<string, AcpToolCallUpdatePayload>();
  private readonly liveToolParts = new Map<string, vscode.ChatToolInvocationPart>();
  private readonly reportedEditToolIds = new Set<string>();
  private livePlanPart: vscode.ChatToolInvocationPart | undefined;

  public constructor(
    browserRenderer: BrowserSubagentRenderer,
    sessionId: string,
    stream: Pick<vscode.ChatResponseStream, 'push'>,
    onFileChange: (change: vscode.ChatSessionFileChange) => void,
    onNeedsInput?: (reason: string) => void,
    private readonly attachmentDir?: string,
  ) {
    this.browserRenderer = browserRenderer;
    this.sessionId = sessionId;
    this.stream = stream;
    this.onFileChange = onFileChange;
    this.onNeedsInput = onNeedsInput;
  }

  public handleUpdate(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        if (isMessageChunkPayload(update)) {
          const text = extractContentBlockText(update.content);
          if (text.length > 0) {
            const thoughtPart = new vscode.ChatResponseThinkingProgressPart(text);
            this.stream.push(thoughtPart as unknown as vscode.ChatResponsePart);
          }
        }
        break;
      }
      case 'agent_message_chunk': {
        if (isMessageChunkPayload(update)) {
          const part = buildStandaloneAgentMessagePart(update.content, this.attachmentDir);
          if (part !== undefined) {
            this.stream.push(part);
            break;
          }
          const text = extractContentBlockText(update.content);
          if (text.length > 0) {
            const mdPart = new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(text));
            this.stream.push(mdPart);
          }
        }
        break;
      }
      case 'plan': {
        if (isPlanUpdatePayload(update)) {
          const planPart = buildPlanToolPart(update.entries, `plan-${this.sessionId}`, this.livePlanPart);
          planPart.enablePartialUpdate = true;
          planPart.isComplete = update.entries.every((entry) => entry.status === 'completed');
          this.livePlanPart = planPart;
          this.stream.push(planPart as unknown as vscode.ChatResponsePart);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (isToolCallUpdatePayload(update)) {
          this.handleLiveToolUpdate(update);
        }
        break;
      }
      default:
        break;
    }
  }

  public flush(): void {
    for (const [toolCallId, merged] of this.toolCallsById.entries()) {
      if (this.reportedEditToolIds.has(toolCallId)) {
        continue;
      }
      if (classifyToolCall(merged, this.browserRenderer) !== 'edit') {
        continue;
      }
      const changes = extractFileChangesFromToolCall(merged);
      if (changes.length > 0) {
        this.reportedEditToolIds.add(toolCallId);
        for (const change of changes) {
          this.onFileChange(change);
        }
      }
    }
    this.browserRenderer.disposeSession(this.sessionId);
  }

  private handleLiveToolUpdate(update: AcpToolCallUpdatePayload): void {
    const previous = this.toolCallsById.get(update.toolCallId);
    const merged = mergeToolCallUpdate(previous, update);
    this.toolCallsById.set(update.toolCallId, merged);

    if (this.browserRenderer.isBrowserSubagentCall(merged)) {
      this.browserRenderer.handleLiveToolCall(merged, this.sessionId, this.stream, this.onNeedsInput);
      return;
    }

    const existingPart = this.liveToolParts.get(merged.toolCallId);
    const part = buildToolInvocationPart(merged, false, existingPart);
    part.enablePartialUpdate = true;
    this.liveToolParts.set(merged.toolCallId, part);
    this.stream.push(part as unknown as vscode.ChatResponsePart);

    const category = classifyToolCall(merged, this.browserRenderer);
    if (category === 'edit' && merged.status === 'completed' && !this.reportedEditToolIds.has(merged.toolCallId)) {
      const changes = extractFileChangesFromToolCall(merged);
      if (changes.length > 0) {
        this.reportedEditToolIds.add(merged.toolCallId);
        for (const change of changes) {
          this.onFileChange(change);
        }
      }
    }
  }
}

function mergeToolCallUpdate(
  previous: AcpToolCallUpdatePayload | undefined,
  incoming: AcpToolCallUpdatePayload,
): AcpToolCallUpdatePayload {
  if (previous === undefined) {
    return {
      ...incoming,
      status: incoming.status ?? 'pending',
    };
  }

  const mergedRawOutput =
    incoming.rawOutput !== undefined ? { ...(previous.rawOutput ?? {}), ...incoming.rawOutput } : previous.rawOutput;

  const mergedLocations =
    incoming.locations !== undefined && incoming.locations.length > 0 ? incoming.locations : previous.locations;

  const mergedContent =
    incoming.content !== undefined && incoming.content.length > 0 ? incoming.content : previous.content;

  return {
    sessionUpdate: incoming.sessionUpdate,
    toolCallId: incoming.toolCallId,
    name: incoming.name ?? previous.name,
    title: incoming.title ?? previous.title,
    kind: incoming.kind ?? previous.kind,
    status: incoming.status ?? previous.status ?? 'pending',
    args: incoming.args ?? previous.args,
    rawInput: incoming.rawInput ?? previous.rawInput,
    rawOutput: mergedRawOutput,
    locations: mergedLocations,
    content: mergedContent,
  };
}

function classifyToolCall(
  merged: AcpToolCallUpdatePayload,
  browserRenderer: BrowserSubagentRenderer,
): ToolCallCategory {
  if (browserRenderer.isBrowserSubagentCall(merged)) {
    return 'browser';
  }

  const name = (merged.name ?? '').toLowerCase();
  const kind = (merged.kind ?? '').toLowerCase();

  if (kind === 'execute' || EXECUTE_TOOL_NAMES.has(name)) {
    return 'execute';
  }
  if (kind === 'read' || READ_TOOL_NAMES.has(name)) {
    return 'read';
  }
  if (kind === 'edit' || EDIT_TOOL_NAMES.has(name) || hasDiffContentItem(merged.content)) {
    return 'edit';
  }
  return 'generic';
}

function buildToolInvocationPart(
  merged: AcpToolCallUpdatePayload,
  isReplay: boolean,
  existingPart?: vscode.ChatToolInvocationPart,
): vscode.ChatToolInvocationPart {
  const category = classifyToolCategoryWithoutBrowser(merged);
  const toolName = category === 'read' ? 'read_file' : (merged.name ?? 'tool');
  const part = existingPart ?? new vscode.ChatToolInvocationPart(toolName, merged.toolCallId);
  const status = merged.status;
  const isComplete = isReplay
    ? status !== 'pending' && status !== 'in_progress'
    : status === 'completed' || status === 'failed';

  part.isComplete = isComplete;
  part.isError = status === 'failed';
  if (isReplay && status === 'completed') {
    part.isConfirmed = true;
  }

  switch (category) {
    case 'execute': {
      populateExecutePart(part, merged, isComplete);
      break;
    }
    case 'read': {
      populateReadPart(part, merged);
      break;
    }
    case 'edit': {
      populateEditPart(part, merged);
      break;
    }
    default: {
      const label = merged.title ?? merged.name ?? 'Tool invocation';
      part.invocationMessage = label;
      part.pastTenseMessage = label;
      break;
    }
  }

  return part;
}

function classifyToolCategoryWithoutBrowser(merged: AcpToolCallUpdatePayload): Exclude<ToolCallCategory, 'browser'> {
  const name = (merged.name ?? '').toLowerCase();
  const kind = (merged.kind ?? '').toLowerCase();

  if (kind === 'execute' || EXECUTE_TOOL_NAMES.has(name)) {
    return 'execute';
  }
  if (kind === 'read' || READ_TOOL_NAMES.has(name)) {
    return 'read';
  }
  if (kind === 'edit' || EDIT_TOOL_NAMES.has(name) || hasDiffContentItem(merged.content)) {
    return 'edit';
  }
  return 'generic';
}

function populateExecutePart(
  part: vscode.ChatToolInvocationPart,
  merged: AcpToolCallUpdatePayload,
  isComplete: boolean,
): void {
  const inputObj = merged.args ?? merged.rawInput ?? {};
  const command =
    getFirstString(inputObj, ['CommandLine', 'commandLine', 'command', 'cmd', 'script']) ?? merged.title ?? '';
  const language = getFirstString(inputObj, ['language', 'shell']) ?? 'pwsh';
  const outputText = extractCommandOutputText(merged);
  const exitCode = extractExitCode(merged.rawOutput);
  const duration = getFirstNumber(merged.rawOutput, ['duration', 'durationMs', 'duration_ms']);

  // The terminal card already shows the command above its output; a past-tense message would repeat it.
  part.invocationMessage = command.length > 0 ? `Run \`${command}\`` : (merged.title ?? 'Run command');

  if (exitCode !== undefined && exitCode !== 0) {
    part.isError = true;
  }

  const terminalData: vscode.ChatTerminalToolInvocationData = {
    commandLine: { original: command },
    language,
  };

  if (outputText !== undefined) {
    terminalData.output = { text: outputText };
  }

  if (exitCode !== undefined || duration !== undefined || isComplete) {
    const stateObj: { exitCode?: number; duration?: number } = {};
    if (exitCode !== undefined) {
      stateObj.exitCode = exitCode;
    }
    if (duration !== undefined) {
      stateObj.duration = duration;
    }
    if (Object.keys(stateObj).length > 0) {
      terminalData.state = stateObj;
    }
  }

  part.toolSpecificData = terminalData;
}

function populateReadPart(part: vscode.ChatToolInvocationPart, merged: AcpToolCallUpdatePayload): void {
  const args = merged.args ?? {};
  const rawInput = merged.rawInput ?? {};
  const pathKeys = ['Path', 'path', 'AbsolutePath', 'absolutePath', 'filePath', 'file_path', 'TargetFile', 'file', 'uri'];
  const filePath = getFirstString(args, pathKeys) ?? getFirstString(rawInput, pathKeys) ?? merged.locations?.[0]?.path;

  if (filePath === undefined || filePath.length === 0) {
    const fallback = merged.title ?? merged.name ?? 'Read file';
    part.invocationMessage = fallback;
    part.pastTenseMessage = fallback;
    return;
  }

  const fileUri = parseUriSafe(filePath).toString();
  const uri = fileUri.replace(/#.*$/, '').replace(/\(/g, '%28').replace(/\)/g, '%29');
  const location = merged.locations?.find((entry) => parseUriSafe(entry.path).toString() === fileUri);
  const startKeys = ['StartLine', 'startLine', 'start_line', 'line'];
  const endKeys = ['EndLine', 'endLine', 'end_line'];
  const startLine = [getFirstNumber(args, startKeys), getFirstNumber(rawInput, startKeys), location?.line].find(isReadLine);
  const endLine = [getFirstNumber(args, endKeys), getFirstNumber(rawInput, endKeys)].find(isReadLine);
  const target = startLine === undefined ? uri : `${uri}#${startLine}-${startLine}`;
  let range = '';
  if (startLine !== undefined) {
    range = endLine !== undefined && endLine > startLine ? `, lines ${startLine} to ${endLine}` : `, line ${startLine}`;
  }
  const link = `[](${target})${range}`;
  part.invocationMessage = new vscode.MarkdownString(`Reading ${link}`);
  part.pastTenseMessage = new vscode.MarkdownString(`${merged.status === 'failed' ? 'Failed to read' : 'Read'} ${link}`);
}

function isReadLine(line: number | undefined): line is number {
  return line !== undefined && Number.isSafeInteger(line) && line > 0;
}

function populateEditPart(part: vscode.ChatToolInvocationPart, merged: AcpToolCallUpdatePayload): void {
  const changes = extractFileChangesFromToolCall(merged);
  const firstChange = changes[0];

  if (firstChange === undefined) {
    const fallback = merged.title ?? merged.name ?? 'Edit file';
    part.invocationMessage = fallback;
    part.pastTenseMessage = fallback;
    return;
  }

  const basename = getPathBasename(
    firstChange.modifiedUri.fsPath.length > 0 ? firstChange.modifiedUri.fsPath : firstChange.modifiedUri.path,
  );
  const nameLower = (merged.name ?? '').toLowerCase();
  const verb = nameLower.includes('write') || nameLower.includes('create') ? 'Write' : 'Edit';
  const totalInsertions = changes.reduce((sum, item) => sum + item.insertions, 0);
  const totalDeletions = changes.reduce((sum, item) => sum + item.deletions, 0);
  const statsText = totalInsertions > 0 || totalDeletions > 0 ? ` (+${totalInsertions} -${totalDeletions})` : '';

  const linkMd = new vscode.MarkdownString(`${verb} [${basename}${statsText}](${firstChange.modifiedUri.toString()})`);
  part.invocationMessage = linkMd;
  part.pastTenseMessage = linkMd;
  part.toolSpecificData = {
    uri: firstChange.modifiedUri.toString(),
    insertions: totalInsertions,
    deletions: totalDeletions,
  };
}

function buildPlanToolPart(
  entries: AcpPlanUpdatePayload['entries'],
  toolCallId: string,
  existingPart?: vscode.ChatToolInvocationPart,
): vscode.ChatToolInvocationPart {
  const part = existingPart ?? new vscode.ChatToolInvocationPart('manage_todo_list', toolCallId);
  part.invocationMessage = 'Updating plan';
  part.pastTenseMessage = 'Updated plan';
  part.isComplete = true;
  part.toolSpecificData = {
    todoList: entries.map((entry, idx) => ({
      id: idx + 1,
      title: entry.content,
      status: mapPlanStatus(entry.status),
    })),
  };
  return part;
}

function mapPlanStatus(status: 'pending' | 'in_progress' | 'completed'): 1 | 2 | 3 {
  switch (status) {
    case 'pending':
      return 1;
    case 'in_progress':
      return 2;
    case 'completed':
      return 3;
  }
}

function extractFileChangesFromToolCall(merged: AcpToolCallUpdatePayload): vscode.ChatSessionFileChange[] {
  const results = new Map<string, MutableFileChange>();

  if (merged.content !== undefined) {
    for (const item of merged.content) {
      if (!isDiffContentItem(item)) {
        continue;
      }
      const uri = parseUriSafe(item.path);
      const stats = computeLineDiffStats(item.oldText, item.newText);
      const hasOldText = item.oldText !== undefined && item.oldText.length > 0;
      accumulateFileChange(results, {
        modifiedUri: uri,
        ...(hasOldText ? { originalUri: uri } : {}),
        insertions: stats.insertions,
        deletions: stats.deletions,
      });
    }
  }

  if (results.size > 0) {
    return materializeFileChanges(results);
  }

  const inputObj = merged.args ?? merged.rawInput ?? {};
  const filePath =
    getFirstString(inputObj, [
      'Path',
      'path',
      'TargetFile',
      'targetFile',
      'filePath',
      'file_path',
      'CodeFile',
      'file',
      'uri',
    ]) ?? merged.locations?.[0]?.path;

  if (filePath === undefined || filePath.length === 0) {
    return [];
  }

  const uri = parseUriSafe(filePath);
  const explicitInsertions = getFirstNumber(merged.rawOutput, ['insertions', 'addedLines']);
  const explicitDeletions = getFirstNumber(merged.rawOutput, ['deletions', 'removedLines']);

  if (explicitInsertions !== undefined || explicitDeletions !== undefined) {
    return [
      {
        modifiedUri: uri,
        originalUri: uri,
        insertions: explicitInsertions ?? 0,
        deletions: explicitDeletions ?? 0,
      },
    ];
  }

  const replacementChunks = inputObj.ReplacementChunks;
  if (Array.isArray(replacementChunks) && replacementChunks.length > 0) {
    let insertions = 0;
    let deletions = 0;
    for (const chunk of replacementChunks) {
      if (!isRecord(chunk)) {
        continue;
      }
      const targetText = getFirstString(chunk, ['TargetContent', 'targetContent', 'oldText']);
      const replacementText = getFirstString(chunk, ['ReplacementContent', 'replacementContent', 'newText']);
      const chunkStats = computeLineDiffStats(targetText, replacementText);
      insertions += chunkStats.insertions;
      deletions += chunkStats.deletions;
    }
    return [
      {
        modifiedUri: uri,
        originalUri: uri,
        insertions,
        deletions,
      },
    ];
  }

  const oldText =
    getFirstString(inputObj, ['Target', 'TargetContent', 'targetContent', 'oldText', 'old_string']) ??
    getFirstString(merged.rawOutput, ['oldText']);
  const newText =
    getFirstString(inputObj, [
      'Replacement',
      'ReplacementContent',
      'replacementContent',
      'newText',
      'new_string',
      'Content',
      'content',
      'CodeContent',
    ]) ?? getFirstString(merged.rawOutput, ['newText']);

  if (oldText !== undefined || newText !== undefined) {
    const stats = computeLineDiffStats(oldText, newText);
    const hasOld = oldText !== undefined && oldText.length > 0;
    return [
      {
        modifiedUri: uri,
        ...(hasOld ? { originalUri: uri } : {}),
        insertions: stats.insertions,
        deletions: stats.deletions,
      },
    ];
  }

  return [
    {
      modifiedUri: uri,
      insertions: 0,
      deletions: 0,
    },
  ];
}

function accumulateFileChange(target: Map<string, MutableFileChange>, change: vscode.ChatSessionFileChange): void {
  const key = change.modifiedUri.toString();
  const existing = target.get(key);
  if (existing !== undefined) {
    existing.insertions += change.insertions;
    existing.deletions += change.deletions;
    if (existing.originalUri === undefined && change.originalUri !== undefined) {
      existing.originalUri = change.originalUri;
    }
    return;
  }

  target.set(key, {
    modifiedUri: change.modifiedUri,
    originalUri: change.originalUri,
    insertions: change.insertions,
    deletions: change.deletions,
  });
}

function materializeFileChanges(map: Map<string, MutableFileChange>): vscode.ChatSessionFileChange[] {
  const result: vscode.ChatSessionFileChange[] = [];
  for (const item of map.values()) {
    result.push({
      modifiedUri: item.modifiedUri,
      ...(item.originalUri !== undefined ? { originalUri: item.originalUri } : {}),
      insertions: item.insertions,
      deletions: item.deletions,
    });
  }
  return result;
}

function computeLineDiffStats(
  oldText: string | undefined,
  newText: string | undefined,
): { readonly insertions: number; readonly deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0) {
    return { insertions: newLines.length, deletions: 0 };
  }
  if (newLines.length === 0) {
    return { insertions: 0, deletions: oldLines.length };
  }

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const trimmedOld = oldLines.slice(prefix, oldLines.length - suffix);
  const trimmedNew = newLines.slice(prefix, newLines.length - suffix);

  if (trimmedOld.length === 0) {
    return { insertions: trimmedNew.length, deletions: 0 };
  }
  if (trimmedNew.length === 0) {
    return { insertions: 0, deletions: trimmedOld.length };
  }

  if (trimmedOld.length * trimmedNew.length > 500_000) {
    return { insertions: trimmedNew.length, deletions: trimmedOld.length };
  }

  const lcs = computeLcsLength(trimmedOld, trimmedNew);
  return {
    insertions: trimmedNew.length - lcs,
    deletions: trimmedOld.length - lcs,
  };
}

function computeLcsLength(left: readonly string[], right: readonly string[]): number {
  const cols = right.length + 1;
  let prev = new Array<number>(cols).fill(0);
  let curr = new Array<number>(cols).fill(0);

  for (const leftLine of left) {
    curr.fill(0);
    for (let j = 1; j < cols; j++) {
      if (leftLine === right[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[cols - 1] ?? 0;
}

function splitLines(text: string | undefined): string[] {
  if (text === undefined || text.length === 0) {
    return [];
  }
  const stripped = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  const effective = stripped.length > 0 ? stripped : text;
  return effective.split(/\r?\n/);
}

function extractCommandOutputText(merged: AcpToolCallUpdatePayload): string | undefined {
  const chunks: string[] = [];

  if (merged.rawOutput !== undefined) {
    const direct = getFirstString(merged.rawOutput, ['output', 'combinedOutput', 'text']);
    if (direct !== undefined) {
      chunks.push(direct);
    } else {
      const stdout = getFirstString(merged.rawOutput, ['stdout']);
      const stderr = getFirstString(merged.rawOutput, ['stderr']);
      if (stdout !== undefined && stdout.length > 0) {
        chunks.push(stdout);
      }
      if (stderr !== undefined && stderr.length > 0) {
        chunks.push(stderr);
      }
    }
  }

  if (chunks.length === 0 && merged.content !== undefined) {
    for (const item of merged.content) {
      if (!isRecord(item)) {
        continue;
      }
      if (item.type === 'content' && isRecord(item.content) && typeof item.content.text === 'string') {
        chunks.push(item.content.text);
      } else if (typeof item.text === 'string') {
        chunks.push(item.text);
      } else if (typeof item.output === 'string') {
        chunks.push(item.output);
      }
    }
  }

  if (chunks.length === 0) {
    return undefined;
  }
  return chunks.join('\n');
}

function extractExitCode(rawOutput: Record<string, unknown> | undefined): number | undefined {
  return getFirstNumber(rawOutput, ['exitCode', 'exit_code', 'code']);
}

function extractContentBlockText(block: AcpContentBlock): string {
  if (typeof block.text === 'string') {
    return block.text;
  }
  if (block.resource !== undefined && typeof block.resource.text === 'string') {
    return block.resource.text;
  }
  return '';
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function resolveMessageAttachment(
  block: AcpContentBlock,
  directory?: string,
): { id: string; name: string; uri: vscode.Uri; image: boolean } | undefined {
  if (block.type === 'text') {
    return undefined;
  }
  const rawUri = block.resource?.uri ?? block.uri;
  const mimeType = block.resource?.mimeType ?? block.mimeType ?? '';
  const imageExtension = IMAGE_EXTENSIONS[mimeType];
  let uri: vscode.Uri | undefined;
  if (rawUri && /^(?:file|https?|vscode-remote):\/\//i.test(rawUri)) {
    uri = vscode.Uri.parse(rawUri);
  } else if (rawUri && /^[a-z]:[\\/]|^[\\/]{1,2}/i.test(rawUri)) {
    uri = vscode.Uri.file(rawUri);
  }

  const data = block.type === 'image' ? block.data : block.resource?.blob;
  const text = block.resource?.text;
  const bytes = data && data.length <= 24_000_000 && (block.type === 'resource' || imageExtension)
    ? Buffer.from(data, 'base64')
    : !uri && text !== undefined && text.length <= 6_000_000 ? Buffer.from(text) : undefined;
  if (directory && bytes?.length) {
    const extension = imageExtension ?? (mimeType === 'application/pdf' ? 'pdf' : data ? 'bin' : 'txt');
    const filename = path.join(directory, `${createHash('sha256').update(bytes).digest('hex')}.${extension}`);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(filename, bytes, { flag: 'wx' });
      uri = vscode.Uri.file(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        uri = vscode.Uri.file(filename);
      }
    }
  }
  if (!uri) {
    return undefined;
  }
  const sourceName = rawUri ? getPathBasename(rawUri.split(/[?#]/, 1)[0] ?? '') : '';
  const name = block.name ?? (sourceName || (imageExtension ? `Image.${imageExtension}` : getPathBasename(uri.path)));
  const image = uri.scheme === 'file' && /\.(png|jpe?g|gif|webp|bmp)$/i.test(uri.path);
  return { id: uri.toString(), name, uri, image };
}

function buildStandaloneAgentMessagePart(block: AcpContentBlock, directory?: string): ResponsePart | undefined {
  if (block.type === 'text' && typeof block.text === 'string') {
    // ACP sends this notice as a standalone text chunk, without a warning field.
    const match = /^⚠\uFE0F?[ \t]+(Your AI credits balance is too low to continue\.)$/.exec(block.text.trim());
    const message = match?.[1];
    if (message !== undefined && typeof vscode.ChatResponseWarningPart === 'function') {
      return new vscode.ChatResponseWarningPart(message);
    }
  }
  const attachment = resolveMessageAttachment(block, directory);
  if (!attachment) {
    return undefined;
  }
  if (!attachment.image) {
    return new vscode.ChatResponseAnchorPart(attachment.uri, attachment.name);
  }
  const target = attachment.uri.toString().replaceAll('(', '%28').replaceAll(')', '%29');
  const name = attachment.name.replace(/[\[\]\\\r\n]/g, ' ');
  return new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(`![${name}](${target})`));
}

function parseUriSafe(rawPath: string): vscode.Uri {
  if (rawPath.startsWith('file://')) {
    return vscode.Uri.parse(rawPath);
  }
  return vscode.Uri.file(rawPath);
}

function getPathBasename(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return base.length > 0 ? base : rawPath;
}

function deriveSessionTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return 'Antigravity Session';
  }
  if (firstLine.length <= 80) {
    return firstLine;
  }
  return `${firstLine.slice(0, 77)}...`;
}

function hasDiffContentItem(content: readonly AcpToolCallContentItem[] | undefined): boolean {
  if (content === undefined) {
    return false;
  }
  return content.some((item) => isDiffContentItem(item));
}

function isDiffContentItem(item: AcpToolCallContentItem): item is AcpToolCallContentDiff {
  return isRecord(item) && item.type === 'diff' && typeof item.path === 'string';
}

function isMessageChunkPayload(
  update: AcpSessionUpdate,
): update is AcpSessionUpdate & { readonly content: AcpContentBlock } {
  return isRecord(update) && isRecord(update.content) && typeof update.content.type === 'string';
}

function isPlanUpdatePayload(update: AcpSessionUpdate): update is AcpPlanUpdatePayload {
  return isRecord(update) && update.sessionUpdate === 'plan' && Array.isArray(update.entries);
}

function isToolCallUpdatePayload(update: AcpSessionUpdate): update is AcpToolCallUpdatePayload {
  return (
    isRecord(update) &&
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
    typeof update.toolCallId === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getFirstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const val = record[key];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

function getFirstNumber(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const val = record[key];
    if (typeof val === 'number' && !Number.isNaN(val)) {
      return val;
    }
  }
  return undefined;
}
