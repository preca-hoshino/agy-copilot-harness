import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockEventEmitter<T> {
    private readonly listeners = new Set<(event: T) => unknown>();

    public readonly event = (listener: (event: T) => unknown) => {
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

  return {
    EventEmitter: MockEventEmitter,
    ThemeIcon: class {
      public constructor(public readonly id: string) {}
    },
  };
});

import type * as vscode from 'vscode';
import type { AcpSessionUpdate } from '../../src/acp/acpTypes.js';
import { AgyLanguageModelProvider } from '../../src/models/agyLanguageModelProvider.js';
import { AgyQuotaService, clusterModelQuotas, parseGetUserStatusPayload, parseQuotaSummary } from '../../src/quota/agyQuotaService.js';
import type { AcpBackendInterface, ModelQuotaInfo } from '../../src/shared/contracts.js';

const NOW_MS = Date.parse('2026-11-19T12:00:00.000Z');
const RESET_5H = '2026-11-19T16:39:00.000Z';
const RESET_WEEKLY = '2026-11-24T12:00:00.000Z';

interface RawClientModelConfig {
  label: string;
  modelOrAlias: { model: string };
  supportsThinking?: boolean;
  supportsImages?: boolean;
  quotaInfo: {
    remainingFraction?: number;
    resetTime?: string;
  };
}

function build24ModelConfigs(): RawClientModelConfig[] {
  const fiveHourModels = [
    { label: 'Gemini 4 Neon', model: 'MODEL_GEMINI_4_NEON', supportsThinking: true, supportsImages: true },
    { label: 'Gemini 4 Hydrogen', model: 'MODEL_GEMINI_4_HYDROGEN', supportsThinking: true, supportsImages: true },
    { label: 'Gemini 3.8 Flash', model: 'MODEL_GEMINI_3_8_FLASH', supportsThinking: true, supportsImages: true },
    {
      label: 'Gemini 3.8 Flash Lite',
      model: 'MODEL_GEMINI_3_8_FLASH_LITE',
      supportsThinking: false,
      supportsImages: true,
    },
    { label: 'Gemini 3.5 Pro', model: 'MODEL_GEMINI_3_5_PRO', supportsThinking: true, supportsImages: true },
    { label: 'Gemini 3.5 Flash', model: 'MODEL_GEMINI_3_5_FLASH', supportsThinking: true, supportsImages: true },
    {
      label: 'Gemini 3.0 Pro (High)',
      model: 'MODEL_GEMINI_3_0_PRO_HIGH',
      supportsThinking: true,
      supportsImages: true,
    },
    { label: 'Gemini 3.0 Pro (Low)', model: 'MODEL_GEMINI_3_0_PRO_LOW', supportsThinking: false, supportsImages: true },
    { label: 'Gemini 2.5 Pro', model: 'MODEL_GEMINI_2_5_PRO', supportsThinking: true, supportsImages: true },
    { label: 'Gemini 2.5 Flash', model: 'MODEL_GEMINI_2_5_FLASH', supportsThinking: false, supportsImages: true },
  ];

  const weeklyModels = [
    { label: 'Gemini 4 Argon', model: 'MODEL_GEMINI_4_ARGON', supportsThinking: true, supportsImages: true },
    { label: 'Orchestrator (Argon)', model: 'MODEL_ORCHESTRATOR_ARGON', supportsThinking: true, supportsImages: true },
    {
      label: 'Claude Opus 5.5 (Thinking)',
      model: 'MODEL_CLAUDE_OPUS_5_5_THINKING',
      supportsThinking: true,
      supportsImages: true,
    },
    { label: 'Claude Opus 5.5', model: 'MODEL_CLAUDE_OPUS_5_5', supportsThinking: false, supportsImages: true },
    {
      label: 'Claude Sonnet 5.5 (Thinking)',
      model: 'MODEL_CLAUDE_SONNET_5_5_THINKING',
      supportsThinking: true,
      supportsImages: true,
    },
    { label: 'Claude Sonnet 5.5', model: 'MODEL_CLAUDE_SONNET_5_5', supportsThinking: false, supportsImages: true },
    { label: 'Claude Haiku 5.5', model: 'MODEL_CLAUDE_HAIKU_5_5', supportsThinking: false, supportsImages: true },
    {
      label: 'Claude Opus 4.5 (Thinking)',
      model: 'MODEL_CLAUDE_OPUS_4_5_THINKING',
      supportsThinking: true,
      supportsImages: true,
    },
    { label: 'Claude Sonnet 4.5', model: 'MODEL_CLAUDE_SONNET_4_5', supportsThinking: false, supportsImages: true },
    { label: 'GPT-OSS 120B (High)', model: 'MODEL_GPT_OSS_120B_HIGH', supportsThinking: true, supportsImages: false },
    {
      label: 'GPT-OSS 120B (Medium)',
      model: 'MODEL_GPT_OSS_120B_MEDIUM',
      supportsThinking: true,
      supportsImages: false,
    },
    { label: 'GPT-OSS 120B (Low)', model: 'MODEL_GPT_OSS_120B_LOW', supportsThinking: false, supportsImages: false },
    { label: 'DeepSeek R2 Preview', model: 'MODEL_DEEPSEEK_R2_PREVIEW', supportsThinking: true, supportsImages: false },
  ];

  const configs: RawClientModelConfig[] = [];

  for (const m of fiveHourModels) {
    configs.push({
      label: m.label,
      modelOrAlias: { model: m.model },
      supportsThinking: m.supportsThinking,
      supportsImages: m.supportsImages,
      quotaInfo: {
        remainingFraction: 0.99,
        resetTime: RESET_5H,
      },
    });
  }

  for (const m of weeklyModels) {
    configs.push({
      label: m.label,
      modelOrAlias: { model: m.model },
      supportsThinking: m.supportsThinking,
      supportsImages: m.supportsImages,
      quotaInfo: {
        remainingFraction: 0.4,
        resetTime: RESET_WEEKLY,
      },
    });
  }

  // 24th model missing resetTime
  configs.push({
    label: 'Antigravity Auto Router',
    modelOrAlias: { model: 'MODEL_AUTO_ROUTER' },
    supportsThinking: true,
    supportsImages: true,
    quotaInfo: {
      remainingFraction: 1,
    },
  });

  return configs;
}

function buildRealisticPayload() {
  return {
    userStatus: {
      email: 'user@example.com',
      name: 'Example User',
      profilePictureUrl: 'https://example.com/avatar.png',
      userTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro',
      },
      planStatus: {
        availablePromptCredits: 1250,
        availableFlowCredits: 400,
        planInfo: {
          monthlyPromptCredits: 5000,
          monthlyFlowCredits: 1000,
        },
      },
      cascadeModelConfigData: {
        clientModelConfigs: build24ModelConfigs(),
      },
    },
  };
}

function createMockBackend(internalHttpPort?: number, csrfToken = 'csrf-token-123'): AcpBackendInterface {
  const updateEmitter = new (class {
    public readonly event: vscode.Event<{ sessionId: string; update: AcpSessionUpdate }> = () => ({
      dispose: () => undefined,
    });
  })();
  const stateEmitter = new (class {
    public readonly event: vscode.Event<{ ready: boolean; error?: string | undefined }> = () => ({
      dispose: () => undefined,
    });
  })();

  return {
    isReady: internalHttpPort !== undefined,
    internalHttpPort,
    csrfToken,
    onDidChangeUpdate: updateEmitter.event,
    onDidChangeBackendState: stateEmitter.event,
    ensureStarted: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    loadSession: async () => ({ sessionId: '' }),
    resumeSession: async () => ({ sessionId: '' }),
    newSession: async () => ({ sessionId: '' }),
    setConfigOption: async () => undefined,
    prompt: async () => ({}),
    cancel: async () => undefined,
    logout: async () => undefined,
    restart: async () => undefined,
    getLastKnownConfigOptions: () => [],
  };
}

function createMockOutputChannel(): vscode.OutputChannel {
  return {
    name: 'Test',
    append: () => undefined,
    appendLine: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

describe('parseGetUserStatusPayload & clusterModelQuotas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clusters GetUserStatus readings without guessing their periods', () => {
    const payload = buildRealisticPayload();
    const snapshot = parseGetUserStatusPayload(payload, 'acp-http', NOW_MS);

    expect(snapshot.signedIn).toBe(true);
    expect(snapshot.source).toBe('acp-http');
    expect(snapshot.email).toBe('user@example.com');
    expect(snapshot.displayName).toBe('Example User');
    expect(snapshot.tierId).toBe('g1-pro-tier');
    expect(snapshot.tierName).toBe('Google AI Pro');
    expect(snapshot.profilePictureUrl).toBe('https://example.com/avatar.png');
    expect(snapshot.availablePromptCredits).toBe(1250);
    expect(snapshot.monthlyPromptCredits).toBe(5000);
    expect(snapshot.availableFlowCredits).toBe(400);
    expect(snapshot.monthlyFlowCredits).toBe(1000);
    expect(snapshot.fetchedAt).toBe(NOW_MS);

    // All 24 models preserved on snapshot.models, including the missing resetTime model
    expect(snapshot.models).toHaveLength(24);
    const missingResetModel = snapshot.models.find((m) => m.modelId === 'MODEL_AUTO_ROUTER');
    expect(missingResetModel).toBeDefined();
    expect(missingResetModel?.resetTime).toBeUndefined();

    // Missing resetTime model ignored in pools when models with resetTime exist
    expect(snapshot.pools).toHaveLength(2);

    const fiveHourPool = snapshot.pools[0];
    const weeklyPool = snapshot.pools[1];

    expect(fiveHourPool).toBeDefined();
    expect(fiveHourPool?.id).toBe('default-gemini');
    expect(fiveHourPool?.label).toBe('Gemini');
    expect(fiveHourPool?.windowLabel).toBeUndefined();
    expect(fiveHourPool?.remainingFraction).toBeCloseTo(0.99);
    expect(fiveHourPool?.usedPercent).toBe(1);
    expect(fiveHourPool?.resetTime).toBe(RESET_5H);
    expect(fiveHourPool?.resetsAtEpochSec).toBe(Math.floor(Date.parse(RESET_5H) / 1000));
    expect(fiveHourPool?.modelLabels).toHaveLength(10);
    expect(fiveHourPool?.modelLabels).not.toContain('Antigravity Auto Router');

    expect(weeklyPool).toBeDefined();
    expect(weeklyPool?.id).toBe('default-gemini-argon-claude-gpt-oss-deepseek');
    expect(weeklyPool?.label).toBe('Gemini Argon & Claude & GPT OSS & DeepSeek');
    expect(weeklyPool?.windowLabel).toBeUndefined();
    expect(weeklyPool?.remainingFraction).toBeCloseTo(0.4);
    expect(weeklyPool?.usedPercent).toBe(60);
    expect(weeklyPool?.resetTime).toBe(RESET_WEEKLY);
    expect(weeklyPool?.resetsAtEpochSec).toBe(Math.floor(Date.parse(RESET_WEEKLY) / 1000));
    expect(weeklyPool?.modelLabels).toHaveLength(13);
  });

  it('distinguishes multiple pools sharing the same bucket and separates Gemini Argon & Claude/GPT OSS', () => {
    const models: ModelQuotaInfo[] = [
      {
        label: 'Gemini 4 Neon (High)',
        modelId: 'gemini-neon',
        remainingFraction: 0.49,
        resetTime: RESET_5H,
      },
      {
        label: 'Gemini 4 Hydrogen (High)',
        modelId: 'gemini-hydrogen',
        remainingFraction: 0.49,
        resetTime: RESET_5H,
      },
      {
        label: 'Orchestrator (Neon)',
        modelId: 'orchestrator-neon',
        remainingFraction: 0.49,
        resetTime: RESET_5H,
      },
      {
        label: 'Gemini 4 Argon (High)',
        modelId: 'gemini-argon',
        remainingFraction: 0.08,
        resetTime: '2026-11-25T06:20:00.000Z',
      },
      {
        label: 'Orchestrator (Argon)',
        modelId: 'orchestrator-argon',
        remainingFraction: 0.08,
        resetTime: '2026-11-25T06:20:00.000Z',
      },
      {
        label: 'Claude Opus 5.5 (High)',
        modelId: 'claude-opus',
        remainingFraction: 0.41,
        resetTime: '2026-11-25T08:24:00.000Z',
      },
      {
        label: 'GPT-OSS 120B (Medium)',
        modelId: 'gpt-oss',
        remainingFraction: 0.41,
        resetTime: '2026-11-25T08:24:00.000Z',
      },
    ];

    const pools = clusterModelQuotas(models);
    expect(pools).toHaveLength(3);
    expect(pools[0]?.label).toBe('Gemini');
    expect(pools[0]?.usedPercent).toBe(51);
    expect(pools[1]?.label).toBe('Gemini Argon');
    expect(pools[1]?.usedPercent).toBe(92);
    expect(pools[2]?.label).toBe('Claude & GPT OSS');
    expect(pools[2]?.usedPercent).toBe(59);
    expect(new Set(pools.map((p) => p.id)).size).toBe(3);
  });

  it('handles unauthenticated payloads cleanly', () => {
    const emptySnapshot = parseGetUserStatusPayload({}, 'acp-http', NOW_MS);
    expect(emptySnapshot.signedIn).toBe(false);
    expect(emptySnapshot.source).toBe('unauthenticated');
    expect(emptySnapshot.models).toEqual([]);
    expect(emptySnapshot.pools).toEqual([]);

    const unauthErrorSnapshot = parseGetUserStatusPayload(
      { code: 'unauthenticated', message: 'Login required' },
      'daemon-hub',
    );
    expect(unauthErrorSnapshot.signedIn).toBe(false);
    expect(unauthErrorSnapshot.source).toBe('unauthenticated');

    const emptyUserStatus = parseGetUserStatusPayload(
      {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [{ label: 'Gemini 4 Neon', modelOrAlias: { model: 'm1' } }],
          },
        },
      },
      'acp-http',
      NOW_MS,
    );
    expect(emptyUserStatus.signedIn).toBe(false);
    expect(emptyUserStatus.source).toBe('unauthenticated');
    expect(emptyUserStatus.models).toHaveLength(1);
  });

  it('treats omitted remainingFraction with resetTime as exhausted (0 remaining, 100% used)', () => {
    const snapshot = parseGetUserStatusPayload(
      {
        userStatus: {
          email: 'user@example.com',
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 4 Neon',
                modelOrAlias: { model: 'MODEL_GEMINI_4_NEON' },
                description: 'Model description from Antigravity',
                quotaInfo: {
                  resetTime: RESET_5H,
                },
              },
            ],
          },
        },
      },
      'acp-http',
      NOW_MS,
    );

    expect(snapshot.signedIn).toBe(true);
    expect(snapshot.models[0]?.remainingFraction).toBe(0);
    expect(snapshot.models[0]?.description).toBe('Model description from Antigravity');
    expect(snapshot.pools[0]?.usedPercent).toBe(100);
  });

  it('falls back to clustering models without resetTime only when no models have resetTime', () => {
    const pools = clusterModelQuotas(
      [
        { label: 'Model A', modelId: 'a', remainingFraction: 0.8 },
        { label: 'Model B', modelId: 'b', remainingFraction: 0.8 },
      ],
    );

    expect(pools).toHaveLength(1);
    expect(pools[0]?.id).toBe('default-model');
    expect(pools[0]?.label).toBe('Model');
    expect(pools[0]?.usedPercent).toBe(20);
    expect(pools[0]?.windowLabel).toBeUndefined();
    expect(pools[0]?.resetsAtEpochSec).toBeUndefined();
  });
});

describe('parseQuotaSummary', () => {
  it('keeps explicit windows independent even with identical readings and an imminent reset', () => {
    const weekly = { bucketId: 'gemini-weekly', window: '7d', remainingFraction: 0.41, resetTime: RESET_5H };
    const short = { ...weekly, bucketId: 'gemini-5h', window: '5h' };
    const pools = parseQuotaSummary({ response: {
      groups: [{ displayName: 'Gemini (Weekly)', buckets: [weekly, short] }],
      buckets: [weekly, { bucketId: 'unknown', remainingAmount: 12 }, { bucketId: 'disabled', disabled: true }],
    } });
    expect(pools).toHaveLength(3);
    expect(pools[0]).toMatchObject({ id: 'gemini-weekly', label: 'Gemini', windowLabel: 'Weekly', usedPercent: 59, resetTime: RESET_5H });
    expect(pools[1]).toMatchObject({ id: 'gemini-5h', label: 'Gemini', windowLabel: '5-Hour', usedPercent: 59 });
    expect(pools[2]?.usedPercent).toBeUndefined();
    expect(pools[2]?.windowLabel).toBeUndefined();
  });
});

describe('AgyLanguageModelProvider', () => {
  const token = { isCancellationRequested: false } as vscode.CancellationToken;

  function createProvider(backend = createMockBackend()): AgyLanguageModelProvider {
    const snapshot = parseGetUserStatusPayload(buildRealisticPayload(), 'acp-http', NOW_MS);
    return new AgyLanguageModelProvider(backend, {
      latestSnapshot: snapshot,
      onDidChangeSnapshot: () => ({ dispose: () => undefined }),
      refresh: async () => snapshot,
      getModelQuota: (id) => snapshot.models.find((model) => model.modelId === id),
    });
  }

  it('uses distinct brand icons and publishes GPT-OSS as one configurable model', async () => {
    const provider = createProvider();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = (id: string) => models?.find((entry) => entry.id === id);
    expect(model('MODEL_ORCHESTRATOR_ARGON')?.statusIcon?.id).toBe('antigravity-logo');
    expect(model('MODEL_GEMINI_4_ARGON')?.statusIcon?.id).toBe('chat-model-provider-gemini');
    expect(model('MODEL_CLAUDE_OPUS_5_5')?.statusIcon?.id).toBe('chat-model-provider-claude');
    expect(models?.filter((entry) => entry.name.startsWith('GPT-OSS')).map((entry) => entry.name)).toEqual(['GPT-OSS 120B']);
    const gpt = model('gpt-oss-120b');
    expect(gpt?.statusIcon?.id).toBe('chat-model-provider-openai');
    expect(gpt?.configurationSchema?.properties.reasoningEffort).toMatchObject({
      enum: ['low', 'medium', 'high'], default: 'medium',
    });
    expect(provider.resolveModelAndEffort('gpt-oss-120b', { reasoningEffort: 'low' })).toEqual({
      modelValue: 'MODEL_GPT_OSS_120B_LOW', thoughtLevel: '',
    });
    provider.dispose();
  });

  it('groups Gemini and Claude by explicit effort while retaining their backend IDs', async () => {
    const backend = createMockBackend();
    backend.getLastKnownConfigOptions = () => [{
      id: 'model', name: 'Model', type: 'select', currentValue: 'neon-high',
      options: [
        { name: 'Gemini 4 Neon (High)', value: 'neon-high' },
        { name: 'Gemini 4 Neon (XHigh)', value: 'neon-extra' },
        { name: 'Claude Sonnet 5.5 (Low)', value: 'sonnet-low' },
        { name: 'Claude Sonnet 5.5 (Medium)', value: 'sonnet-medium' },
        { name: 'Orchestrator (Neon)', value: 'orchestrator-neon' },
      ],
    }];
    const provider = createProvider(backend);
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(models?.map((model) => model.name)).toEqual(['Gemini 4 Neon', 'Claude Sonnet 5.5', 'Orchestrator (Neon)']);
    expect(models?.[0]?.configurationSchema?.properties.reasoningEffort).toMatchObject({ enum: ['high', 'xhigh'], default: 'high' });
    expect(provider.resolveModelAndEffort('antigravity/gemini-4-neon', { reasoningEffort: 'xhigh' })).toEqual({
      modelValue: 'neon-extra', thoughtLevel: '',
    });
    expect(provider.resolveModelAndEffort('claude-sonnet-5-5', { reasoningEffort: 'low' })).toEqual({
      modelValue: 'sonnet-low', thoughtLevel: '',
    });
    expect(provider.resolveModelAndEffort('neon-high')).toEqual({ modelValue: 'neon-high', thoughtLevel: '' });
    provider.dispose();
  });

  it('uses the active ACP variant by default and only exposes advertised variants', async () => {
    const backend = createMockBackend();
    backend.getLastKnownConfigOptions = () => [{
      id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-oss-high-alias',
      options: [
        { name: 'GPT OSS 120B (Medium)', value: 'gpt-oss-medium-alias' },
        { name: 'GPT OSS 120B (High)', value: 'gpt-oss-high-alias' },
      ],
    }];
    const provider = createProvider(backend);
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(models).toHaveLength(1);
    expect(models?.[0]?.configurationSchema?.properties.reasoningEffort).toMatchObject({
      enum: ['medium', 'high'], default: 'high',
    });
    expect(provider.resolveModelAndEffort('antigravity/gpt-oss-120b').modelValue).toBe('gpt-oss-high-alias');
    expect(provider.resolveModelAndEffort('antigravity/gpt-oss-120b', { reasoningEffort: 'medium' }).modelValue).toBe('gpt-oss-medium-alias');
    provider.dispose();
  });
});

describe('AgyQuotaService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries acp-http first when backend port is ready and caches models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(buildRealisticPayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const backend = createMockBackend(45123, 'secret-csrf');
    const service = new AgyQuotaService(backend, createMockOutputChannel(), path.join(os.tmpdir(), 'missing-daemon'));

    const events: boolean[] = [];
    service.onDidChangeSnapshot((snap) => {
      events.push(snap.signedIn);
    });

    const snapshot = await service.refresh();
    expect(snapshot.signedIn).toBe(true);
    expect(snapshot.source).toBe('acp-http');
    expect(events).toEqual([true]);
    expect(service.getModelQuota('MODEL_CLAUDE_OPUS_5_5')?.remainingFraction).toBe(0.4);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:45123/exa.language_server_pb.LanguageServerService/GetUserStatus',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': 'secret-csrf',
        },
      }),
    );

    service.dispose();
  });

  it('falls back to newest alive daemon/hub_*.json during cold start', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-daemon-test-'));
    try {
      // Dead PID hub file should be skipped
      await fs.writeFile(
        path.join(tempDir, 'hub_99999999.json'),
        JSON.stringify({ pid: 99999999, httpPort: 11111, csrfToken: 'dead-token' }),
        'utf8',
      );
      // Alive PID (current test process) hub file should be used
      await fs.writeFile(
        path.join(tempDir, `hub_${process.pid}.json`),
        JSON.stringify({ pid: process.pid, httpPort: 52345, csrfToken: 'alive-hub-csrf' }),
        'utf8',
      );

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(buildRealisticPayload()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const backend = createMockBackend(undefined, '');
      const service = new AgyQuotaService(backend, createMockOutputChannel(), tempDir);
      const snapshot = await service.refresh();

      expect(snapshot.signedIn).toBe(true);
      expect(snapshot.source).toBe('daemon-hub');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:52345/exa.language_server_pb.LanguageServerService/GetUserStatus',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-codeium-csrf-token': 'alive-hub-csrf',
          }),
        }),
      );

      service.dispose();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
