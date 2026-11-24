import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockEventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: (): void => {
          this.listeners.delete(listener);
        },
      };
    };

    public fire(data: T): void {
      for (const listener of this.listeners) {
        listener(data);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }

  class MockThemeIcon {
    public constructor(public readonly id: string) {}
  }

  return {
    EventEmitter: MockEventEmitter,
    ThemeIcon: MockThemeIcon,
  };
});

import type * as vscode from 'vscode';
import { AgyLanguageModelProvider } from '../../src/models/agyLanguageModelProvider.js';
import { buildChatResponseUsage, mapTokenGroupsToPromptDetails } from '../../src/sessions/contextUsageBreakdown.js';
import type { AcpBackendInterface, AgyContextWindowUsage, QuotaServiceInterface } from '../../src/shared/contracts.js';

describe('contextUsageBreakdown', () => {
  it('maps real agy.exe tokenGroups into ordered System and User Context percentage details', () => {
    const usage: AgyContextWindowUsage = {
      estimatedTokensUsed: 356_757,
      maxContextTokens: 512_000,
      tokenGroups: [
        { name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', source: 'TOKEN_SOURCE_USER', numTokens: 336_770 },
        { name: 'Tools', type: 'TOKEN_TYPE_TOOLS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 8_624 },
        { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 5_586 },
        { name: 'Skills', type: 'TOKEN_TYPE_SKILLS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 2_157 },
        { name: 'Subagents', type: 'TOKEN_TYPE_SUBAGENTS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 1_886 },
        { name: 'Plugins', type: 'TOKEN_TYPE_PLUGINS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 1_734 },
        { name: 'Empty Rules', type: 'TOKEN_TYPE_RULES', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 0 },
      ],
    };

    const details = mapTokenGroupsToPromptDetails(usage);
    expect(details.map((entry) => [entry.category, entry.label])).toEqual([
      ['System', 'System Instructions'],
      ['System', 'Tool Definitions'],
      ['System', 'Skills'],
      ['System', 'Sub-agents'],
      ['System', 'Plugins'],
      ['User Context', 'Messages'],
    ]);

    const totalPct = details.reduce((sum, entry) => sum + entry.percentageOfPrompt, 0);
    expect(totalPct).toBeGreaterThan(99.9);
    expect(totalPct).toBeLessThanOrEqual(100);
  });

  it('aggregates duplicate groups, handles fallback names, and leaves uncategorized slack below 100%', () => {
    const usage: AgyContextWindowUsage = {
      estimatedTokensUsed: 100_000,
      maxContextTokens: 256_000,
      tokenGroups: [
        { name: 'MCP A', type: 'TOKEN_TYPE_MCP_TOOLS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 10_000 },
        { name: 'MCP B', type: 'TOKEN_TYPE_MCP_TOOLS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 5_000 },
        { name: 'Rules', type: 'TOKEN_TYPE_RULES', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 5_000 },
        { name: 'Workflows', type: 'TOKEN_TYPE_WORKFLOWS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 2_500 },
        { name: 'Flows', type: 'TOKEN_TYPE_FLOWS', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 2_500 },
        { name: 'Pinned Docs', type: 'TOKEN_TYPE_UNSPECIFIED', source: 'TOKEN_SOURCE_USER', numTokens: 15_000 },
        { name: 'Custom System', type: 'TOKEN_TYPE_NEW_FUTURE', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 10_000 },
      ],
    };

    const details = mapTokenGroupsToPromptDetails(usage);
    expect(details).toEqual([
      { category: 'System', label: 'MCP Tools', percentageOfPrompt: 15 },
      { category: 'System', label: 'Rules', percentageOfPrompt: 5 },
      { category: 'System', label: 'Workflows', percentageOfPrompt: 2.5 },
      { category: 'System', label: 'Flows', percentageOfPrompt: 2.5 },
      { category: 'System', label: 'Custom System', percentageOfPrompt: 10 },
      { category: 'User Context', label: 'Pinned Docs', percentageOfPrompt: 15 },
    ]);
  });

  it('subtracts completionTokens from promptTokens cleanly in buildChatResponseUsage without double counting', () => {
    const breakdown: AgyContextWindowUsage = {
      estimatedTokensUsed: 62_000,
      maxContextTokens: 256_000,
      completionTokens: 2_000,
      tokenGroups: [
        { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', source: 'TOKEN_SOURCE_SYSTEM', numTokens: 10_000 },
        { name: 'Chat Messages', type: 'TOKEN_TYPE_CHAT_MESSAGES', source: 'TOKEN_SOURCE_USER', numTokens: 52_000 },
      ],
    };

    const withDetails = buildChatResponseUsage({ totalUsed: 60_000, breakdown });
    expect(withDetails.promptTokens).toBe(60_000);
    expect(withDetails.completionTokens).toBe(2_000);
    expect(withDetails.promptTokens + withDetails.completionTokens).toBe(62_000);
    expect(withDetails.promptTokenDetails).toHaveLength(2);

    const fallbackOnly = buildChatResponseUsage({ totalUsed: 12_500 });
    expect(fallbackOnly).toEqual({ promptTokens: 12_500, completionTokens: 0 });
  });

  it('prevents nominal ACP usage.size from overriding authoritative maxContextTokens in AgyLanguageModelProvider', () => {
    const backend = {
      isReady: true,
      internalHttpPort: undefined,
      csrfToken: '',
      onDidChangeUpdate: () => ({ dispose: () => undefined }),
      onDidChangeBackendState: () => ({ dispose: () => undefined }),
      getLastKnownConfigOptions: () => [
        {
          id: 'model',
          category: 'model',
          name: 'Model',
          currentValue: 'claude-sonnet-4-6-high',
          options: [
            { value: 'claude-sonnet-4-6-high', name: 'Claude Sonnet 4.6 (high)' },
            { value: 'gemini-3-pro', name: 'Gemini 3 Pro' },
          ],
        },
      ],
    } as unknown as AcpBackendInterface;

    const quotaService = {
      latestSnapshot: {
        signedIn: true,
        models: [
          { modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', remainingFraction: 1 },
          { modelId: 'gemini-3-pro', label: 'Gemini 3 Pro', remainingFraction: 1 },
        ],
        pools: [],
        fetchedAt: Date.now(),
        source: 'acp-http',
      },
      onDidChangeSnapshot: () => ({ dispose: () => undefined }),
      refresh: vi.fn(),
      getModelQuota: () => undefined,
    } as unknown as QuotaServiceInterface;

    const provider = new AgyLanguageModelProvider(backend, quotaService);
    const changes = vi.fn();
    provider.onDidChangeLanguageModelChatInformation(changes);

    // Non-authoritative ACP ceiling arrives first
    provider.recordContextWindow('antigravity/claude-sonnet-4-6', 1_048_576, false);
    // Authoritative contextWindowUsage ceiling overrides it
    provider.recordContextWindow('antigravity/claude-sonnet-4-6', 256_000, true);
    // Subsequent nominal ACP ceiling must not revert the authoritative 256K window
    provider.recordContextWindow('antigravity/claude-sonnet-4-6', 1_048_576, false);

    const token: vscode.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    const infos = provider.provideLanguageModelChatInformation({ silent: true }, token) as vscode.LanguageModelChatInformation[];
    const claude = infos.find((info) => info.id === 'claude-sonnet-4-6');

    expect(claude?.maxContextWindowTokens).toBe(256_000);
    expect(claude?.maxInputTokens).toBe(256_000);
    expect(provider.getModelContextLimit('antigravity/claude-sonnet-4-6-high')).toBe(256_000);
    expect(changes).toHaveBeenCalledTimes(2);

    // ACP usage_update above old hardcoded 200K/128K heuristics must never be clamped down.
    provider.recordContextWindow('antigravity/gemini-3-pro', 2_000_000, false);
    const updatedInfos = provider.provideLanguageModelChatInformation({ silent: true }, token) as vscode.LanguageModelChatInformation[];
    const gemini = updatedInfos.find((info) => info.id === 'gemini-3-pro');
    expect(gemini?.maxContextWindowTokens).toBe(2_000_000);
    expect(gemini?.maxInputTokens).toBe(2_000_000);
    expect(gemini?.maxOutputTokens).toBe(0);

    provider.dispose();
  });
});
