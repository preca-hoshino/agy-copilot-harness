import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FormattingOptions, ParseError } from 'jsonc-parser';
import { applyEdits, modify, parse } from 'jsonc-parser';
import * as vscode from 'vscode';

const ARGV_PROPOSED_API_KEY = 'enable-proposed-api';
const RELOAD_WINDOW_LABEL = 'Reload Window';

export interface ArgvPatchResult {
  changed: boolean;
  content: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detectFormattingOptions(content: string): FormattingOptions {
  const usesTabs = /(?:^|\n)\t/.test(content);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (usesTabs) {
    return {
      tabSize: 4,
      insertSpaces: false,
      eol,
    };
  }

  const spaceIndentMatch = /\n( +)"/.exec(content);
  const detectedSpaces = spaceIndentMatch?.[1]?.length;
  const tabSize = detectedSpaces === 4 ? 4 : 2;
  return {
    tabSize,
    insertSpaces: true,
    eol,
  };
}

function hasExtensionId(entries: readonly unknown[], extensionId: string): boolean {
  const normalizedTarget = extensionId.toLowerCase();
  for (const item of entries) {
    if (typeof item === 'string' && item.toLowerCase() === normalizedTarget) {
      return true;
    }
  }
  return false;
}

export function getDefaultArgvPath(): string {
  return path.join(os.homedir(), '.vscode', 'argv.json');
}

export function ensureProposedApiInArgvContent(content: string, extensionId: string): ArgvPatchResult {
  const trimmedId = extensionId.trim();
  if (trimmedId.length === 0) {
    return { changed: false, content };
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(content, errors, { allowTrailingComma: true });
  const rawValue: unknown = isPlainRecord(parsed) ? parsed[ARGV_PROPOSED_API_KEY] : undefined;
  const formattingOptions = detectFormattingOptions(content);

  let edits: ReturnType<typeof modify>;

  if (typeof rawValue === 'string') {
    if (rawValue.toLowerCase() === trimmedId.toLowerCase()) {
      return { changed: false, content };
    }
    edits = modify(content, [ARGV_PROPOSED_API_KEY], [rawValue, trimmedId], { formattingOptions });
  } else if (Array.isArray(rawValue)) {
    if (hasExtensionId(rawValue, trimmedId)) {
      return { changed: false, content };
    }
    edits = modify(content, [ARGV_PROPOSED_API_KEY, -1], trimmedId, {
      isArrayInsertion: true,
      formattingOptions,
    });
  } else {
    edits = modify(content, [ARGV_PROPOSED_API_KEY], [trimmedId], { formattingOptions });
  }

  const nextContent = applyEdits(content, edits);
  if (nextContent === content) {
    return { changed: false, content };
  }

  return { changed: true, content: nextContent };
}

function hasCreateChatSessionItemController(chatApi: Partial<typeof vscode.chat> | undefined): boolean {
  return typeof chatApi?.createChatSessionItemController === 'function';
}

export function isProposedApiAvailable(): boolean {
  return hasCreateChatSessionItemController(vscode.chat);
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function checkAndEnsureProposedApi(
  extensionId: string,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  if (isProposedApiAvailable()) {
    return true;
  }

  const argvPath = getDefaultArgvPath();
  let existingContent = '';

  try {
    existingContent = await fs.readFile(argvPath, 'utf8');
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      outputChannel.appendLine(`[bootstrap] Failed to read ${argvPath}: ${formatErrorMessage(error)}`);
    }
  }

  const patchResult = ensureProposedApiInArgvContent(existingContent, extensionId);
  let patchedSuccessfully = !patchResult.changed;

  if (patchResult.changed) {
    try {
      await fs.mkdir(path.dirname(argvPath), { recursive: true });
      await fs.writeFile(argvPath, patchResult.content, 'utf8');
      patchedSuccessfully = true;
      outputChannel.appendLine(`[bootstrap] Added "${extensionId}" to "${ARGV_PROPOSED_API_KEY}" in ${argvPath}.`);
    } catch (error: unknown) {
      outputChannel.appendLine(`[bootstrap] Failed to write ${argvPath}: ${formatErrorMessage(error)}`);
    }
  } else {
    outputChannel.appendLine(
      `[bootstrap] "${extensionId}" is already present in ${argvPath}, waiting for VS Code reload/restart.`,
    );
  }

  const message = patchedSuccessfully
    ? `Antigravity Copilot Harness enabled proposed APIs in ${argvPath}. Reload VS Code to activate.`
    : `Antigravity Copilot Harness requires "${extensionId}" in "${ARGV_PROPOSED_API_KEY}" inside ${argvPath}. Please update argv.json and reload VS Code.`;

  const selection = await vscode.window.showInformationMessage(message, RELOAD_WINDOW_LABEL);
  if (selection === RELOAD_WINDOW_LABEL) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  return false;
}
