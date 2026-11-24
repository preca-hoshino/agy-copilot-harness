import * as vscode from 'vscode';
import type { AcpPlanUpdatePayload, AcpToolCallUpdatePayload } from '../acp/acpTypes.js';

export interface TodoListItem {
  readonly id: number;
  readonly title: string;
  readonly status: 1 | 2 | 3;
}

interface MutableTaskPhase {
  readonly id: number;
  readonly normalizedName: string;
  readonly name: string;
  title: string;
  status: 1 | 2 | 3;
}

const COMPLETED_STATUS_RE = /^(?:done|complete|completed|finished|success)$/i;

/**
 * Return whether an ACP tool update represents an Antigravity `task_boundary` call.
 */
export function isTaskBoundaryCall(update: AcpToolCallUpdatePayload): boolean {
  return (update.name ?? '').trim().toLowerCase() === 'task_boundary';
}

/**
 * Build or update a `manage_todo_list` tool invocation part carrying native todo list state.
 */
export function buildTodoToolPart(
  todoList: readonly TodoListItem[],
  toolCallId: string,
  existingPart?: vscode.ChatToolInvocationPart,
  presentation?: 'hidden' | 'hiddenAfterComplete',
): vscode.ChatToolInvocationPart {
  const part = existingPart ?? new vscode.ChatToolInvocationPart('manage_todo_list', toolCallId);
  part.invocationMessage = 'Updating plan';
  part.pastTenseMessage = 'Updated plan';
  part.isComplete = true;
  if (presentation !== undefined) {
    part.presentation = presentation;
  }
  part.toolSpecificData = {
    todoList: todoList.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
    })),
  };
  return part;
}

/**
 * Track session task state from ACP `plan` updates and native `task_boundary` tool calls.
 */
export class AgyTaskListTracker {
  private hasExplicitPlan = false;
  private explicitTodos: TodoListItem[] = [];
  private readonly phases: MutableTaskPhase[] = [];
  private nextPhaseId = 1;

  public applyPlanUpdate(entries: AcpPlanUpdatePayload['entries']): readonly TodoListItem[] {
    this.hasExplicitPlan = entries.length > 0;
    this.explicitTodos = entries.map((entry, idx) => ({
      id: idx + 1,
      title: entry.content,
      status: mapAcpPlanStatus(entry.status),
    }));
    return this.getTodoList();
  }

  public applyTaskBoundary(update: AcpToolCallUpdatePayload): readonly TodoListItem[] | undefined {
    if (!isTaskBoundaryCall(update) || this.hasExplicitPlan) {
      return undefined;
    }

    const input = update.args ?? update.rawInput;
    const rawName = readFirstNonEmptyString(input, ['TaskName', 'taskName', 'task_name']);
    if (rawName === undefined) {
      return undefined;
    }

    const name = collapseWhitespace(rawName);
    const normalizedName = name.toLowerCase();
    const rawStatus = readFirstNonEmptyString(input, ['TaskStatus', 'taskStatus', 'task_status']);
    const statusText = rawStatus !== undefined ? collapseWhitespace(rawStatus) : undefined;
    const isTerminal = update.status === 'failed' || (statusText !== undefined && COMPLETED_STATUS_RE.test(statusText));
    const status: 1 | 2 | 3 = isTerminal ? 3 : 2;
    const displayTitle =
      status === 2 && statusText !== undefined && statusText.toLowerCase() !== normalizedName
        ? `${name}: ${statusText}`
        : name;

    for (const phase of this.phases) {
      if (phase.normalizedName !== normalizedName && phase.status === 2) {
        phase.status = 3;
        phase.title = phase.name;
      }
    }

    const existing = this.phases.find((phase) => phase.normalizedName === normalizedName);
    if (existing !== undefined) {
      existing.status = status;
      existing.title = displayTitle;
    } else {
      this.phases.push({
        id: this.nextPhaseId,
        normalizedName,
        name,
        title: displayTitle,
        status,
      });
      this.nextPhaseId += 1;
    }

    return this.getTodoList();
  }

  public completeActiveTaskPhases(): readonly TodoListItem[] | undefined {
    if (this.hasExplicitPlan || this.phases.length === 0) {
      return undefined;
    }
    let changed = false;
    for (const phase of this.phases) {
      if (phase.status === 2) {
        phase.status = 3;
        phase.title = phase.name;
        changed = true;
      }
    }
    return changed ? this.getTodoList() : undefined;
  }

  public getTodoList(): readonly TodoListItem[] {
    if (this.hasExplicitPlan) {
      return this.explicitTodos.map((item) => ({ ...item }));
    }
    return this.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      status: phase.status,
    }));
  }
}

function mapAcpPlanStatus(status: 'pending' | 'in_progress' | 'completed'): 1 | 2 | 3 {
  switch (status) {
    case 'pending':
      return 1;
    case 'in_progress':
      return 2;
    case 'completed':
      return 3;
  }
}

function readFirstNonEmptyString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
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

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
