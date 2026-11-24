import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { QuotaPoolSummary } from '../../src/shared/contracts.js';

const requireFromProject = createRequire(`${process.cwd()}/package.json`);
const {
  applyLiveTurnStats,
  createTerminalApproval,
  extractHistoryUsageParts,
  patchSessionsContent,
  patchWorkbenchContent,
  renderQuotaGroups,
  renderQuotaRow,
  isAntigravityModeGroup,
  resolveModePermissionsViewModel,
  buildModePermissionsActionItems,
} = requireFromProject('./scripts/patch-sessions-ui.js');
const {
  buildQuestionCarouselNotifySnippet,
  buildRemoteTerminalApprovalSnippet,
  buildTerminalApprovalSnippet,
} = requireFromProject('./scripts/ui-patch/snippets/terminal-approval.js');
const { buildSessionsPanelSnippet } = requireFromProject('./scripts/ui-patch/snippets/sessions-panel.js');
const {
  buildEditingActionNotifySnippet,
  buildEditorEditingSessionSnippet,
  buildExternalEditBaselineSnippet,
  buildLiveEditPillSnippet,
  buildSideChatSessionSnippet,
  buildSubagentReadOnlySnippet,
  buildSubagentSessionInputSnippet,
  buildWorkingSetDedupSnippet,
} = requireFromProject('./scripts/ui-patch/snippets/working-set.js');
const {
  buildSessionsNewModeActionSnippet,
  buildSessionsNewModeViewItemSnippet,
  buildSessionsProviderSnippet,
  buildSessionsSubagentOpenerSnippet,
  buildSessionsSubagentTrackSnippet,
} = requireFromProject('./scripts/ui-patch/snippets/sessions-provider.js');
const { buildLiveTurnStatsSnippet } = requireFromProject('./scripts/ui-patch/snippets/session-usage.js');

class FakeInvocation {
  public readonly confirm = vi.fn();
  public readonly didCancelTool = vi.fn();
  public readonly didExecuteTool = vi.fn();
  public readonly confirmation = { confirm: this.confirm };
  public readonly state = { get: () => this.confirmation };

  public constructor(public readonly prepared: unknown) {}
}

function createApproval() {
  const options = [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }];
  const id = `agy-terminal:${JSON.stringify({ command: 'Get-ChildItem', cwd: 'D:\\project', options })}`;
  const progress = {
    resolveId: 'resolve-1',
    questions: [{ id, options: options.map(({ optionId }) => ({ id: optionId, value: optionId, label: optionId })) }],
  };
  let onChange = (): void => {};
  const dispose = vi.fn();
  const response = {
    isComplete: false,
    onDidChange(callback: () => void) {
      onChange = callback;
      return { dispose };
    },
  };
  const send = vi.fn();
  const invocation: FakeInvocation = createTerminalApproval(progress, 'request-1', response, FakeInvocation, {}, send);
  return { id, invocation, send, dispose, finish: () => { response.isComplete = true; onChange(); } };
}

describe('native terminal approval', () => {
  it('shows the original command read-only and sends a single answer to the same request', () => {
    const { id, invocation, send, dispose } = createApproval();
    expect(invocation.prepared).toMatchObject({
      toolSpecificData: { kind: 'terminal', editable: false, commandLine: { original: 'Get-ChildItem' } },
      confirmationMessages: { customOptions: [{ id: 'yes', kind: 'approve' }, { id: 'no', kind: 'deny' }] },
    });
    invocation.confirmation.confirm({ type: 4, selectedButton: 'yes' });
    invocation.confirmation.confirm({ type: 4, selectedButton: 'no' });
    expect(send).toHaveBeenCalledExactlyOnceWith('request-1', 'resolve-1', { [id]: 'yes' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('returns the backend rejection ID for Skip without marking execution successful', () => {
    const { id, invocation, send } = createApproval();
    invocation.confirmation.confirm({ type: 4, selectedButton: 'no' });
    expect(send).toHaveBeenCalledExactlyOnceWith('request-1', 'resolve-1', { [id]: 'no' });
    expect(invocation.didExecuteTool).not.toHaveBeenCalled();
  });

  it('cancels when a confirmation does not identify a valid option', () => {
    const { invocation, send } = createApproval();
    invocation.confirmation.confirm({ type: 4, selectedButton: 'unknown' });
    expect(send).toHaveBeenCalledExactlyOnceWith('request-1', 'resolve-1', undefined);
    expect(invocation.didExecuteTool).not.toHaveBeenCalled();
  });

  it('closes when the response ends and ignores late clicks', () => {
    const { invocation, send, finish } = createApproval();
    finish();
    invocation.confirmation.confirm({ type: 4, selectedButton: 'yes' });
    expect(invocation.didCancelTool).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('approves with allow_once when confirmed without selectedButton and rejects on Dismiss/Skip All', () => {
    const allowed = createApproval();
    allowed.invocation.confirmation.confirm({ type: 4 });
    expect(allowed.send).toHaveBeenCalledExactlyOnceWith('request-1', 'resolve-1', { [allowed.id]: 'yes' });
    expect(allowed.invocation.didExecuteTool).toHaveBeenCalledTimes(1);

    const dismissed = createApproval();
    dismissed.invocation.confirmation.confirm({ type: 5 });
    expect(dismissed.send).toHaveBeenCalledExactlyOnceWith('request-1', 'resolve-1', { [dismissed.id]: 'no' });
    expect(dismissed.invocation.didExecuteTool).not.toHaveBeenCalled();
  });

  it('bridges terminal approval and question carousel answers in restored ChatService streams for antigravity only', () => {
    const remoteSnippet = buildRemoteTerminalApprovalSnippet(
      { slice: 'D', session: 'e', req: 'c', silent: 'x' },
      { invocation: 'FakeInvocation', source: 'ToolSource' },
      { sessionType: 'getSessionType' },
    );
    const notifySnippet = buildQuestionCarouselNotifySnippet(
      { reqId: 'e', resolveId: 't', answers: 'i' },
      { sessionType: 'getSessionType' },
    );
    expect(remoteSnippet).toContain('agy-terminal:');
    expect(remoteSnippet).toContain('antigravityHarness._resolveQuestionCarousel');
    expect(notifySnippet).toContain('!_agyReq.response?.isComplete');

    const executed: Array<{ cmd: string; payload: unknown }> = [];
    const options = [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }];
    const termQId = `agy-terminal:${JSON.stringify({ command: 'ls', cwd: 'D:\\repo', options })}`;
    const fakeReq = {
      id: 'req-restored',
      response: {
        isComplete: false,
        onDidChange: () => ({ dispose() {} }),
        response: {
          value: [{ kind: 'questionCarousel', resolveId: 'res-elicit', questions: [{ id: 'agy-ask-1' }] }],
        },
      },
    };
    const fakeSessionModel = {
      sessionResource: { scheme: 'antigravity', toString: () => 'antigravity:/s1' },
      acceptResponseProgress: vi.fn(),
      getRequests: () => [fakeReq],
    };

    const harness = {
      sessionModels: new Map([['antigravity:/s1', fakeSessionModel]]),
      executed,
      runRemote(D: unknown[], e: typeof fakeSessionModel, c: typeof fakeReq, x: boolean) {
        const ctx = { commandService: { executeCommand: (cmd: string, payload: unknown) => { executed.push({ cmd, payload }); return Promise.resolve(); } } };
        const fn = new Function(
          'D', 'e', 'c', 'x', 'FakeInvocation', 'ToolSource', 'getSessionType',
          `return (function(){${remoteSnippet} return D;}).call(this);`,
        );
        return fn.call(ctx, D, e, c, x, FakeInvocation, { External: 'ext' }, (r: { scheme: string }) => r.scheme);
      },
      runNotify(e: string, t: string, i: unknown) {
        const ctx = {
          _sessionModels: harness.sessionModels,
          commandService: { executeCommand: (cmd: string, payload: unknown) => { executed.push({ cmd, payload }); return Promise.resolve(); } },
        };
        const fn = new Function('e', 't', 'i', 'getSessionType', `return (function(){${notifySnippet}}).call(this);`);
        return fn.call(ctx, e, t, i, (r: { scheme: string }) => r.scheme);
      },
    };

    const transformed = harness.runRemote(
      [{ kind: 'questionCarousel', resolveId: 'res-term', questions: [{ id: termQId, options: [{ id: 'yes', value: 'yes', label: 'Yes' }] }] }],
      fakeSessionModel,
      fakeReq,
      false,
    ) as FakeInvocation[];
    expect(transformed[0]).toBeInstanceOf(FakeInvocation);
    transformed[0]?.confirmation.confirm({ type: 4, selectedButton: 'yes' });
    expect(executed[0]).toEqual({
      cmd: 'antigravityHarness._resolveQuestionCarousel',
      payload: {
        sessionResource: 'antigravity:/s1',
        requestId: 'req-restored',
        resolveId: 'res-term',
        questionIds: [termQId],
        answers: { [termQId]: 'yes' },
      },
    });

    harness.runNotify('req-restored', 'res-elicit', { 'agy-ask-1': 'vitest' });
    expect(executed[1]).toEqual({
      cmd: 'antigravityHarness._resolveQuestionCarousel',
      payload: {
        sessionResource: 'antigravity:/s1',
        requestId: 'req-restored',
        resolveId: 'res-elicit',
        questionIds: ['agy-ask-1'],
        answers: { 'agy-ask-1': 'vitest' },
      },
    });

    // Completed response disposal must NOT trigger spurious skip/resolve.
    fakeReq.response.isComplete = true;
    harness.runNotify('req-restored', 'res-elicit', undefined);
    expect(executed).toHaveLength(2);
    expect(buildTerminalApprovalSnippet({ invocation: 'FakeInvocation', source: 'ToolSource' }, { sessionType: 'getSessionType' })).toContain('agy-terminal:');
  });
});

describe('historical session usage extraction', () => {
  it('converts AGY_USAGE markers into native usage parts only for antigravity sessions', () => {
    const agyHistory = [
      { type: 'request', prompt: 'hi' },
      {
        type: 'response',
        parts: [
          { kind: 'markdownContent', content: { value: 'Hello' } },
          { kind: 'markdownContent', content: { value: '<!--AGY_USAGE:{"used":42000,"size":1048576}-->' } },
        ],
      },
    ];
    extractHistoryUsageParts(agyHistory, { scheme: 'antigravity' });
    expect(agyHistory[1]?.parts).toEqual([
      { kind: 'markdownContent', content: { value: 'Hello' } },
      {
        kind: 'usage',
        promptTokens: 42000,
        completionTokens: 0,
        contextUsage: { currentTokens: 42000, tokenLimit: 1048576 },
      },
    ]);

    const otherHistory = [
      {
        type: 'response',
        parts: [{ kind: 'markdownContent', content: { value: '<!--AGY_USAGE:{"used":42000,"size":1048576}-->' } }],
      },
    ];
    extractHistoryUsageParts(otherHistory, { scheme: 'copilotcli' });
    expect(otherHistory[0]?.parts).toEqual([
      { kind: 'markdownContent', content: { value: '<!--AGY_USAGE:{"used":42000,"size":1048576}-->' } },
    ]);

    const detailedHistory = [
      {
        type: 'response',
        parts: [
          {
            kind: 'markdownContent',
            content: {
              value:
                '<!--AGY_USAGE:{"used":62000,"size":256000,"completionTokens":2000,"details":[{"category":"System","label":"System Instructions","percentageOfPrompt":11.6},{"category":"User Context","label":"A\\u003eB","percentageOfPrompt":88.4},{"category":"Invalid","percentageOfPrompt":5}]}-->',
            },
          },
        ],
      },
    ];
    extractHistoryUsageParts(detailedHistory, { scheme: 'antigravity' });
    expect(detailedHistory[0]?.parts).toEqual([
      {
        kind: 'usage',
        promptTokens: 60000,
        completionTokens: 2000,
        contextUsage: { currentTokens: 62000, tokenLimit: 256000 },
        promptTokenDetails: [
          { category: 'System', label: 'System Instructions', percentageOfPrompt: 11.6 },
          { category: 'User Context', label: 'A>B', percentageOfPrompt: 88.4 },
        ],
      },
    ]);
  });

  it('converts completed historical agyEdit tool calls to native externalEdit pills and leaves failed ones visible', () => {
    class MockResourceUri {
      public readonly scheme = 'antigravity';
      public constructor(public readonly raw: string) {}
      public static parse(raw: string): MockResourceUri {
        return new MockResourceUri(raw);
      }
      public toString(): string {
        return this.raw;
      }
    }
    const history = [
      {
        type: 'response',
        parts: [
          {
            kind: 'toolInvocationSerialized',
            toolCallId: 'tc-multi',
            isComplete: true,
            subAgentInvocationId: 'sub-1',
            toolSpecificData: {
              agyEdit: true,
              uri: 'file:///repo/a.ts',
              insertions: 11,
              deletions: 10,
              editKind: 'edit',
              changes: [
                { uri: 'file:///repo/a.ts', insertions: 11, deletions: 10, editKind: 'edit' },
                { uri: 'file:///repo/new.ts', insertions: 5, deletions: 0, editKind: 'create' },
              ],
            },
          },
          {
            kind: 'toolInvocationSerialized',
            toolCallId: 'tc-failed',
            isComplete: true,
            toolSpecificData: {
              agyEdit: false,
              uri: 'file:///repo/failed.ts',
              insertions: 1,
              deletions: 0,
              editKind: 'create',
            },
          },
        ],
      },
    ];
    extractHistoryUsageParts(history, new MockResourceUri('antigravity:/s1'));
    expect(history[0]?.parts).toHaveLength(4);
    expect(history[0]?.parts[0]).toMatchObject({ kind: 'toolInvocationSerialized', toolCallId: 'tc-multi', presentation: 'hidden' });
    expect(history[0]?.parts[1]).toEqual({
      kind: 'externalEdit',
      uri: new MockResourceUri('file:///repo/a.ts'),
      editKind: 'edit',
      diff: { added: 11, removed: 10 },
      afterContentUri: new MockResourceUri('file:///repo/a.ts'),
      undoStopId: 'tc-multi',
      subAgentInvocationId: 'sub-1',
    });
    expect(history[0]?.parts[2]).toEqual({
      kind: 'externalEdit',
      uri: new MockResourceUri('file:///repo/new.ts'),
      editKind: 'create',
      diff: { added: 5, removed: 0 },
      afterContentUri: new MockResourceUri('file:///repo/new.ts'),
      undoStopId: 'tc-multi',
      subAgentInvocationId: 'sub-1',
    });
    expect(history[0]?.parts[3]).toMatchObject({ kind: 'toolInvocationSerialized', toolCallId: 'tc-failed' });
    expect((history[0]?.parts[3] as { presentation?: string }).presentation).toBeUndefined();
  });
});

class FakeNode {
  public readonly ownerDocument = { createElement: () => new FakeNode() };
  public readonly children: FakeNode[] = [];
  public readonly style: Record<string, string> = {};
  public readonly attributes: Record<string, string> = {};
  public readonly classList = {
    add: (...classes: string[]): void => {
      this.className = [this.className, ...classes].filter(Boolean).join(' ');
    },
  };
  public className = '';
  public textContent = '';
  public tabIndex = -1;

  public appendChild(child: FakeNode): FakeNode { this.children.push(child); return child; }
  public append(child: FakeNode, text: string): void { this.appendChild(child); this.textContent = text; }
  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  public child(name: string): FakeNode | undefined { return this.children.find((child) => child.className === name); }
}

it('keeps separate progress bars per quota cycle in the status bar hover', () => {
  const host = new FakeNode();
  renderQuotaGroups(host, [
    { label: 'Gemini', windowLabel: 'Weekly', resetLabel: 'Nov 25', usedPercent: 93 },
    { label: 'Claude', windowLabel: 'Weekly', usedPercent: 100 },
    { label: 'Gemini', windowLabel: '5-Hour', resetLabel: 'Nov 20', usedPercent: 0 },
  ], renderQuotaRow, vi.fn());
  expect(host.children.map((group) => group.child('agy-quota-name')?.textContent)).toEqual(['Gemini', 'Claude']);
  const rows = host.children[0]?.children.filter((node) => node.className === 'agy-quota-row');
  expect(rows?.map((row) => row.child('agy-quota-header')?.child('agy-quota-timing')?.textContent)).toEqual(['Weekly · Nov 25', '5-Hour · Nov 20']);
  expect(rows?.map((row) => row.child('agy-quota-track')?.child('agy-quota-fill')?.style.width)).toEqual(['93%', '0%']);
});

const provider = 'sessions-account-titlebar-panel-provider-';
type SessionsQuotaPool = Pick<QuotaPoolSummary, 'label' | 'usedPercent' | 'windowLabel' | 'modelLabels'> & {
  resetLabel?: string;
};

function renderSessionsAccount(pools: SessionsQuotaPool[]) {
  const snippet = buildSessionsPanelSnippet(
    { append: 'append', element: 'element' },
    { actionBar: 'ActionBar', action: 'Action' },
    { chatStatusToken: 'chatStatusToken' },
  );
  const renderPanel = runInNewContext(`(function(l,e){${snippet}})`, {
    append: (parent: FakeNode, child: FakeNode) => parent.appendChild(child),
    element: (selector: string, attributes?: Record<string, string>, text?: string) => {
      const node = new FakeNode();
      node.className = selector.split('.').slice(1).join(' ');
      Object.assign(node.attributes, attributes);
      node.textContent = text ?? '';
      return node;
    },
    ActionBar: class {
      public readonly onWillRun = vi.fn();
      public readonly push = vi.fn();
    },
    Action: class {},
    chatStatusToken: 'chatStatusItemService',
  });

  const panel = new FakeNode();
  const setupDelayedHover = vi.fn();
  const entries = [
    {
      id: 'antigravity.providerAccount',
      tooltip: `<!--AGY_META:${JSON.stringify({ signedIn: true, tierName: 'Google AI Pro', pools })}-->`,
    },
  ];
  const accountService = { get: () => ({ getEntries: () => entries }) };
  renderPanel.call(
    {
      instantiationService: { invokeFunction: (fn: (service: typeof accountService) => unknown) => fn(accountService) },
      hoverService: { setupDelayedHover },
    },
    panel,
    { add: (value: unknown) => value },
  );
  return { usage: panel.child(`${provider}account`)?.child(`${provider}usage`), setupDelayedHover };
}

describe('Agents account quota panel', () => {
  it('shows plan and model groups with compact native metric rows instead of progress bars', () => {
    const { usage, setupDelayedHover } = renderSessionsAccount([
      {
        label: 'Gemini',
        windowLabel: 'Weekly',
        resetLabel: 'Resets Nov 25',
        usedPercent: 93,
        modelLabels: ['Gemini Pro'],
      },
      { label: 'Claude', windowLabel: 'Weekly', modelLabels: [] },
      { label: 'Gemini', windowLabel: '5-Hour', usedPercent: 0, modelLabels: [] },
    ]);
    const title = (node?: FakeNode) =>
      node?.child(`${provider}metric-row primary`)?.child(`${provider}plan`)?.textContent;
    expect(title(usage)).toBe('Google AI Pro');
    const [gemini, claude] = usage?.children.slice(1) ?? [];
    expect([title(gemini), title(claude)]).toEqual(['Gemini', 'Claude']);

    const rows = (group?: FakeNode) =>
      group?.children
        .slice(1)
        .map((row) => [row.className, row.children.map((cell) => [cell.className, cell.textContent])]);
    const metricRow = (timing: string, value: string) => [
      `${provider}metric-row secondary`,
      [
        [`${provider}reset`, timing],
        [`${provider}usage-value`, value],
      ],
    ];
    const percent = new Intl.NumberFormat(undefined, { style: 'percent' });
    expect(rows(gemini)).toEqual([
      metricRow('Weekly · Resets Nov 25', `${percent.format(0.93)} used`),
      metricRow('5-Hour', `${percent.format(0)} used`),
    ]);
    expect(rows(claude)).toEqual([metricRow('Weekly', 'Usage unavailable')]);
    const weeklyRow = gemini?.children[1];
    expect(weeklyRow?.tabIndex).toBe(0);
    expect(weeklyRow?.attributes['aria-label']).toContain('Models: Gemini Pro');
    expect(setupDelayedHover).toHaveBeenCalledExactlyOnceWith(
      weeklyRow,
      { content: 'Models: Gemini Pro' },
      { setupKeyboardEvents: true },
    );
  });

  it('reports missing quota data without a usage value', () => {
    const { usage, setupDelayedHover } = renderSessionsAccount([]);
    const row = usage?.child(`${provider}metric-row secondary`);
    expect(row?.children.map((cell) => cell.textContent)).toEqual(['No quota pools reported yet.']);
    expect(setupDelayedHover).not.toHaveBeenCalled();
  });
});

describe('working set, editing action, and side chat UI snippets', () => {
  it('strips __agy_before, suppresses duplicate B8s parts for antigravity, and converts completed live edits into externalEdit pills', async () => {
    const baselineSnippet = buildExternalEditBaselineSnippet({
      item: 'p',
      session: 'r',
      idx: 'h',
      reqId: 'l',
      revive: 'revive',
      parts: 'c',
    });
    const livePillSnippet = buildLiveEditPillSnippet({
      item: 'p',
      session: 'r',
      reqId: 'l',
      parts: 'c',
    });
    const startExternalEdits = vi.fn(async () => ['b8s-part']);
    const stopExternalEdits = vi.fn(async () => ['stop-part']);

    class FakeUri {
      public readonly scheme = 'file';
      public constructor(public readonly path: string, public readonly query = '') {}
      public static parse(raw: string): FakeUri {
        return new FakeUri(raw, '');
      }
      public with(change: { query?: string }): FakeUri {
        return new FakeUri(this.path, change.query ?? this.query);
      }
      public toString(): string {
        const clean = this.path.startsWith('file://') ? this.path : `file://${this.path}`;
        return this.query.length > 0 ? `${clean}?${this.query}` : clean;
      }
    }

    const runner = runInNewContext(
      `(async function(t,r,h,l,c,revive){for(const p of t){${baselineSnippet.replace('if(r?.sessionResource?.scheme', 'if(p.kind==="externalEdits"&&r?.sessionResource?.scheme')}if(p.kind==="externalEdits"){if(r?.editingSession&&h!==void 0&&l){let f=p.start?await r.editingSession.startExternalEdits(l,h,revive(p.resources),p.undoStopId):await r.editingSession.stopExternalEdits(l,h);c.push(...f)}continue}${livePillSnippet}c.push(p)}})`,
    );

    const streamingTool = { kind: 'toolInvocation', toolCallId: 'edit-1', presentation: undefined as string | undefined };
    const reqModel: {
      _response: { _responseParts: Array<Record<string, unknown>> };
      __agyBeforeUris?: Map<string, FakeUri>;
    } = {
      _response: { _responseParts: [streamingTool] },
    };
    const snapshotOriginal = new FakeUri('chat-editing-snapshot-text-model:/workspace/a.ts');
    const getEntry = vi.fn(() => ({ originalURI: snapshotOriginal }));
    const agySession = {
      sessionResource: { scheme: 'antigravity', constructor: FakeUri },
      editingSession: { startExternalEdits, stopExternalEdits, getEntry },
    };
    const agyParts: Array<Record<string, unknown>> = [
      { kind: 'externalToolInvocationUpdate', toolCallId: 'edit-1', isComplete: false },
    ];
    const target = new FakeUri('/workspace/a.ts', `__agy_before=${encodeURIComponent('file:///tmp/base.tmp')}`);

    // First run the completed tool update before startExternalEdits finishes (matching async tracker timing).
    await runner(
      [
        {
          kind: 'externalToolInvocationUpdate',
          toolCallId: 'edit-1',
          isComplete: true,
          toolSpecificData: {
            agyEdit: true,
            uri: 'file:///workspace/a.ts',
            insertions: 3,
            deletions: 1,
            editKind: 'edit',
          },
        },
        { kind: 'externalEdits', start: true, resources: [target], undoStopId: 'u1' },
        { kind: 'externalEdits', start: false, resources: [target], undoStopId: 'u1' },
      ],
      agySession,
      0,
      reqModel,
      agyParts,
      (x: unknown) => x,
    );

    expect(startExternalEdits).toHaveBeenCalledOnce();
    const call = startExternalEdits.mock.calls[0] as unknown[];
    expect((call[2] as FakeUri[])[0]?.query).toBe('');
    expect((call[4] as FakeUri[])[0]?.path).toBe('file:///tmp/base.tmp');
    expect(streamingTool.presentation).toBe('hidden');
    // Stale in-batch partial update was stripped; closing update + single externalEdit pill remain (no B8s parts).
    expect(agyParts).toHaveLength(2);
    expect(agyParts[0]).toMatchObject({ kind: 'externalToolInvocationUpdate', toolCallId: 'edit-1', isComplete: true });
    expect(agyParts[1]).toEqual({
      kind: 'externalEdit',
      uri: new FakeUri('file:///workspace/a.ts'),
      editKind: 'edit',
      diff: { added: 3, removed: 1 },
      beforeContentUri: snapshotOriginal,
      afterContentUri: new FakeUri('file:///workspace/a.ts'),
      undoStopId: 'edit-1',
    });

    // Non-antigravity sessions still pass through VS Code's default externalEdits + externalToolInvocationUpdate behavior.
    const copilotParts: unknown[] = [];
    await runner(
      [
        { kind: 'externalEdits', start: true, resources: [new FakeUri('/workspace/b.ts')], undoStopId: 'u2' },
        {
          kind: 'externalToolInvocationUpdate',
          toolCallId: 'c1',
          isComplete: true,
          toolSpecificData: { agyEdit: true, uri: 'file:///workspace/b.ts', insertions: 1, deletions: 0 },
        },
      ],
      { sessionResource: { scheme: 'copilotcli', constructor: FakeUri }, editingSession: { startExternalEdits, stopExternalEdits } },
      0,
      reqModel,
      copilotParts,
      (x: unknown) => x,
    );
    expect(copilotParts[0]).toBe('b8s-part');
    expect((copilotParts[1] as { kind: string }).kind).toBe('externalToolInvocationUpdate');

    // Already-completed duplicate toolInvocation cards in _response._responseParts are spliced out cleanly
    const completedDuplicate = {
      kind: 'toolInvocation',
      toolCallId: 'edit-2',
      presentation: undefined as string | undefined,
      state: { get: () => ({ type: 4 }) },
    };
    const completedReqModel: {
      _response: { _responseParts: Array<Record<string, unknown>> };
    } = {
      _response: { _responseParts: [completedDuplicate] },
    };
    const dedupParts: Array<Record<string, unknown>> = [];
    await runner(
      [
        {
          kind: 'externalToolInvocationUpdate',
          toolCallId: 'edit-2',
          isComplete: true,
          toolSpecificData: {
            agyEdit: true,
            uri: 'file:///workspace/c.ts',
            insertions: 2,
            deletions: 1,
            editKind: 'edit',
          },
        },
      ],
      agySession,
      0,
      completedReqModel,
      dedupParts,
      (x: unknown) => x,
    );
    expect(completedReqModel._response._responseParts).toEqual([]);
    expect(dedupParts).toHaveLength(1);
    expect(dedupParts[0]).toMatchObject({
      kind: 'externalEdit',
      uri: new FakeUri('file:///workspace/c.ts'),
      diff: { added: 2, removed: 1 },
    });
  });

  it('deduplicates session.changes (n) against live and decided ChatEditingSession entries (i / t.entries) for antigravity only', () => {
    const snippet = buildWorkingSetDedupSnippet({ arg1: 't', arg2: 'i', arg3: 'n' });
    const fn = runInNewContext(`(function(e,t,i,n){${snippet}return{live:i.read(null),session:n.read(null)};})`);

    const agyRes = fn(
      null,
      { chatSessionResource: { scheme: 'antigravity' }, entries: { read: () => [{ modifiedURI: 'file:///kept.ts' }] } },
      { read: () => [{ reference: 'file:///a.ts' }] },
      { read: () => [{ reference: 'file:///a.ts' }, { reference: 'file:///kept.ts' }, { reference: 'file:///b.ts' }] },
    );
    expect(agyRes.live).toEqual([{ reference: 'file:///a.ts' }]);
    expect(agyRes.session).toEqual([{ reference: 'file:///b.ts' }]);

    const agyReloadRes = fn(
      null,
      { chatSessionResource: { scheme: 'antigravity' }, entries: { read: () => [] } },
      { read: () => [] },
      { read: () => [{ reference: 'file:///a.ts' }, { reference: 'file:///b.ts' }] },
    );
    expect(agyReloadRes.live).toEqual([]);
    expect(agyReloadRes.session).toEqual([{ reference: 'file:///a.ts' }, { reference: 'file:///b.ts' }]);

    const copilotRes = fn(
      null,
      { chatSessionResource: { scheme: 'copilotcli' } },
      { read: () => [{ reference: 'file:///a.ts' }] },
      { read: () => [{ reference: 'file:///a.ts' }] },
    );
    expect(copilotRes.live).toEqual([{ reference: 'file:///a.ts' }]);
    expect(copilotRes.session).toEqual([{ reference: 'file:///a.ts' }]);
  });

  it('forwards Keep/Undo actions to antigravityHarness._onEditingAction and bridges createSideChat', async () => {
    const actionSnippet = buildEditingActionNotifySnippet({ action: 'e' });
    const executeCommand = vi.fn(async () => undefined);
    const notifyFn = runInNewContext(`(function(e){if(true){this.noop()${actionSnippet}}})`);
    notifyFn.call(
      { noop: () => {}, commandService: { executeCommand } },
      { sessionResource: { scheme: 'antigravity' }, action: { kind: 'chatEditingSessionAction', outcome: 'accepted' } },
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'antigravityHarness._onEditingAction',
      { scheme: 'antigravity' },
      { kind: 'chatEditingSessionAction', outcome: 'accepted' },
    );

    const sideSnippet = buildSideChatSessionSnippet({ revive: 'Rs' });
    const forkMock = vi.fn(async (_h: unknown, _r: unknown, dto: { command?: string; prompt?: string }) => ({ dto, resource: 'antigravity:/side-1' }));
    const sessionObj: Record<string, unknown> = {
      sessionResource: { scheme: 'antigravity', toString: () => 'antigravity:/main-1' },
      _providerHandle: 1,
      _proxy: { $forkChatSession: forkMock },
      createSideChat: undefined,
      sideChatOrigin: undefined,
    };
    const initFn = runInNewContext(`(function(Rs){globalThis.__agySideChatOrigins=void 0;void 0${sideSnippet}})`);
    initFn.call(sessionObj, (x: unknown) => x);
    const created = await (sessionObj.createSideChat as (t: string, tok: unknown, sel: string) => Promise<{ resource: string }>)(
      'turn-1',
      null,
      'selected code',
    );
    expect(created.resource).toBe('antigravity:/side-1');
    expect(forkMock).toHaveBeenCalledWith(
      1,
      sessionObj.sessionResource,
      expect.objectContaining({ command: 'btw', participant: 'antigravity.agent' }),
      null,
    );
  });
});

describe('Antigravity 2-tier mode and permissions picker', () => {
  function makeGroup(selectedId: string, lastInteractiveMode = 'default') {
    const items = [
      {
        id: 'default',
        name: 'Default',
        description: 'Ask before edits and commands',
        icon: { id: 'shield' },
        agyPickerMeta: {
          provider: 'antigravity',
          category: 'permission',
          pickerLabel: 'Manual permissions',
          shortLabel: 'Manual',
          detail: 'Ask before edits and commands',
          tone: '',
          lastInteractiveMode,
        },
      },
      {
        id: 'accept-edits',
        name: 'Accept edits',
        description: 'Auto-approve workspace file edits',
        icon: { id: 'edit' },
        agyPickerMeta: {
          provider: 'antigravity',
          category: 'permission',
          pickerLabel: 'Accept edits',
          shortLabel: 'Accept edits',
          detail: 'Auto-approve workspace file edits',
          tone: 'info',
          lastInteractiveMode,
        },
      },
      {
        id: 'auto',
        name: 'Auto',
        description: 'Automatically approve one-time tool requests',
        icon: { id: 'zap' },
        agyPickerMeta: {
          provider: 'antigravity',
          category: 'permission',
          pickerLabel: 'Auto',
          shortLabel: 'Auto',
          detail: 'Automatically approve one-time tool requests',
          tone: 'warning',
          lastInteractiveMode,
        },
      },
      {
        id: 'plan',
        name: 'Plan',
        description: 'Plan changes before executing',
        icon: { id: 'checklist' },
        agyPickerMeta: {
          provider: 'antigravity',
          category: 'mode',
          pickerLabel: 'Plan',
          shortLabel: 'Plan',
          detail: 'Plan changes before executing',
          tone: '',
          lastInteractiveMode,
        },
      },
    ];
    return {
      id: 'mode',
      name: 'Agent Mode',
      items,
      selected: items.find((item) => item.id === selectedId),
    };
  }

  it('activates only for antigravity mode pickers and leaves other providers alone', () => {
    expect(isAntigravityModeGroup(makeGroup('default'), { scheme: 'antigravity' })).toBe(true);
    expect(isAntigravityModeGroup(makeGroup('default'), { scheme: 'copilotcli' })).toBe(true);
    expect(isAntigravityModeGroup({ id: 'mode', items: [{ id: 'default', name: 'Default' }] }, { scheme: 'copilotcli' })).toBe(false);
    expect(isAntigravityModeGroup({ id: 'model', items: [{ id: 'm1', name: 'Model' }] }, { scheme: 'antigravity' })).toBe(false);
  });

  it('resolves Copilot-style split button labels and tones for default, accept-edits, auto, and plan', () => {
    const defVm = resolveModePermissionsViewModel(makeGroup('default'), undefined, undefined);
    expect(defVm).toMatchObject({ isPlan: false, modeLabel: 'Interactive', modeIconId: 'comment', permShortLabel: 'Manual', permTone: '' });

    const editVm = resolveModePermissionsViewModel(makeGroup('accept-edits'), undefined, undefined);
    expect(editVm).toMatchObject({ isPlan: false, modeLabel: 'Interactive', modeIconId: 'comment', permShortLabel: 'Accept edits', permTone: 'info' });

    const autoVm = resolveModePermissionsViewModel(makeGroup('auto'), undefined, undefined);
    expect(autoVm).toMatchObject({ isPlan: false, modeLabel: 'Interactive', modeIconId: 'comment', permShortLabel: 'Auto', permTone: 'warning' });

    const planVm = resolveModePermissionsViewModel(makeGroup('plan', 'accept-edits'), undefined, undefined);
    expect(planVm).toMatchObject({
      isPlan: true,
      modeLabel: 'Plan',
      modeIconId: 'checklist',
      permShortLabel: 'Accept edits',
      permTone: '',
      activePermItem: expect.objectContaining({ id: 'accept-edits' }),
    });
  });

  interface ModePickerActionListItem {
    readonly kind: string;
    readonly label: string;
    readonly detail?: string;
    readonly section?: string;
    readonly isSectionToggle?: boolean;
    readonly disabled?: boolean;
    readonly focusableWhenDisabled?: boolean;
    readonly description?: string;
    readonly className?: string;
    readonly toolbarActions?: Array<{ readonly run: () => void }>;
    readonly item: {
      readonly id: string;
      readonly enabled?: boolean;
      readonly checked?: boolean;
      readonly run: () => void;
    };
  }

  it('builds 2-tier Agent mode + Permissions sections without Sandbox row and keeps popup descriptions stable in Plan mode', () => {
    const onSelectInteractive = vi.fn();
    const onSelectPlan = vi.fn();
    const onSelectPermission = vi.fn();
    const onConfigurePermissions = vi.fn();

    const interactiveVm = resolveModePermissionsViewModel(makeGroup('auto', 'auto'), undefined, undefined);
    const items = buildModePermissionsActionItems(interactiveVm, {
      onSelectInteractive,
      onSelectPlan,
      onSelectPermission,
      onConfigurePermissions,
    }) as ModePickerActionListItem[];

    const modeItems = items.filter((item) => item.kind === 'action' && !item.isSectionToggle && item.section === 'agentHostModePicker.mode');
    expect(modeItems.map((item) => item.label)).toEqual(['Interactive', 'Plan']);
    expect(modeItems.map((item) => item.item.checked)).toEqual([true, false]);

    const permItems = items.filter(
      (item) => item.kind === 'action' && !item.isSectionToggle && item.section === 'agentHostModePicker.permissions',
    );
    expect(permItems.map((item) => item.label)).toEqual([
      'Manual permissions',
      'Accept edits',
      'Auto',
    ]);
    expect(permItems.map((item) => item.disabled)).toEqual([false, false, false]);
    expect(permItems[2]?.item.checked).toBe(true);
    expect(items.some((item) => item.label === 'Sandboxing for terminal' || item.item?.id === 'antigravity.sandboxStatus')).toBe(false);

    // Gear button opens Harness settings
    const permHeader = items.find((item) => item.isSectionToggle && item.section === 'agentHostModePicker.permissions');
    expect(permHeader?.className).toBe('agent-host-mode-permissions warning');
    permHeader?.toolbarActions?.[0]?.run();
    expect(onConfigurePermissions).toHaveBeenCalledOnce();

    // Selecting Plan keeps identical header description and option detail widths without bloating text
    const planVm = resolveModePermissionsViewModel(makeGroup('plan', 'auto'), undefined, 'accept-edits');
    const planItems = buildModePermissionsActionItems(planVm, {
      onSelectInteractive,
      onSelectPlan,
      onSelectPermission,
      onConfigurePermissions,
    }) as ModePickerActionListItem[];
    const planPermHeader = planItems.find(
      (item) => item.isSectionToggle && item.section === 'agentHostModePicker.permissions',
    );
    expect(planPermHeader?.description).toBe('Accept edits');
    const planPerms = planItems.filter(
      (item) => item.kind === 'action' && !item.isSectionToggle && item.section === 'agentHostModePicker.permissions',
    );
    expect(planPerms.every((item) => item.disabled === true && item.focusableWhenDisabled === true)).toBe(true);
    expect(planPerms.map((item) => item.detail)).toEqual(permItems.map((item) => item.detail));

    // Clicking disabled permission in Plan mode does not invoke callback
    planPerms[0]?.item.run();
    expect(onSelectPermission).not.toHaveBeenCalled();

    // Clicking Interactive in Plan mode restores remembered interactive item (accept-edits)
    const planModeItems = planItems.filter(
      (item) => item.kind === 'action' && !item.isSectionToggle && item.section === 'agentHostModePicker.mode',
    );
    planModeItems[0]?.item.run();
    expect(onSelectInteractive).toHaveBeenCalledWith(expect.objectContaining({ id: 'accept-edits' }));
  });
});

describe('Antigravity Sessions Window provider snippet', () => {
  it('routes first chat send through updateChatSessionState, skips untitled flicker, and replaces draft with realized session', async () => {
    const providerSnippet = buildSessionsProviderSnippet(
      { services: 'svc', inst: 'inst', regSvc: 'reg', disp: 'disp', prov: 'baseProv', xfeCls: 'Xfe' },
      { uriCls: 'Uri', uuidFn: 'uuid', draftCls: 'Draft', inst: 'instantiationService' },
      { itemCls: 'CacheItem' },
      { getModels: 'getModels', resolveModel: 'resolveModel' },
    );
    const modeViewItemSnippet = buildSessionsNewModeViewItemSnippet(
      { reg: 'reg', menuId: 'NewMenu', mgmtSvc: 'MgmtTok' },
      { mutCls: 'OptPicker' },
      { chatInput: 'MenuId' },
    );
    const modeActionSnippet = buildSessionsNewModeActionSnippet(
      { disp: 'store', regAct: 'regAct', actCls: 'Act2' },
      { expr: 'Expr', sessionsWin: 'SessWin', ctx: 'Ctx', tiKey: 'TiKey', menuId: 'NewMenu' },
      { chatInput: 'MenuId', isSess: 'IsSess' },
    );
    expect(modeViewItemSnippet).toContain('antigravity.newSessionModePicker');
    expect(modeViewItemSnippet).toContain('antigravity.chatSessionModePicker');
    expect(modeViewItemSnippet).toContain('MenuId.ChatInput');
    expect(modeActionSnippet).toContain('antigravity.newSessionModePicker');
    expect(modeActionSnippet).toContain('antigravity.chatSessionModePicker');
    expect(modeActionSnippet).toContain('sessionUsesExperimentalComposerLayout');

    const sentPayloads: Array<{ resource: unknown; query: string; opts: Record<string, unknown> }> = [];
    const updatedOptions: Array<{ resource: unknown; options: Map<string, unknown> }> = [];
    const replacements: Array<{ from: unknown; to: unknown }> = [];
    const sessionListeners = new Set<() => void>();
    const sessionsList: Array<Record<string, unknown>> = [];

    const makeUri = (scheme: string, path: string, fsPath?: string) => ({
      scheme,
      path,
      fsPath: fsPath ?? path,
      toString: () => `${scheme}:${path}`,
    });

    class Draft {
      public readonly resource: ReturnType<typeof makeUri>;
      public readonly sessionWorkspace: unknown;
      public readonly target: string;
      public readonly providerId: string;
      public readonly sessionType: string;
      public readonly sessionId: string;
      public readonly selectedOptions = new Map<string, unknown>();
      public readonly mainChat: { get: () => { resource: ReturnType<typeof makeUri> } };
      public selectedModelId: string | undefined = 'antigravity:gemini-2.5-pro';
      public modelConfiguration = { getModelConfigurationForRequest: () => ({ reasoningEffort: 'high' }) };
      public icon: unknown = { id: 'cloud' };
      public statusVal = 0;

      public constructor(res: ReturnType<typeof makeUri>, ws: unknown, target: string, pid: string) {
        this.resource = res;
        this.sessionWorkspace = ws;
        this.target = target;
        this.providerId = pid;
        this.sessionType = target;
        this.sessionId = `${pid}:${res.toString()}`;
        this.mainChat = { get: () => ({ resource: res }) };
      }

      public setCreatedBySession(): void {}
      public setOption(key: string, val: unknown): void {
        this.selectedOptions.set(key, val);
      }
      public setTitle(): void {}
      public setStatus(next: number): void {
        this.statusVal = next;
      }
      public dispose(): void {}
    }

    class CacheItem {
      public readonly sessionId: string;
      public readonly resource: ReturnType<typeof makeUri>;
      public readonly providerId: string;
      public readonly sessionType: string;
      public icon = { id: 'cloud' };
      public readonly status = { get: () => 3 };
      public readonly workspace: { get: () => unknown };
      public readonly mainChat: { get: () => { resource: ReturnType<typeof makeUri> } };

      public constructor(s: Record<string, unknown>, pid: string) {
        this.resource = s.resource as ReturnType<typeof makeUri>;
        this.sessionId = `${pid}:${this.resource.toString()}`;
        this.providerId = pid;
        this.sessionType = String(s.providerType);
        this.workspace = { get: () => this._buildWorkspace(s) };
        this.mainChat = { get: () => ({ resource: this.resource }) };
      }

      public update(): boolean {
        return false;
      }

      public _buildWorkspace(_s: unknown): Record<string, unknown> {
        return {
          uri: makeUri('unknown', '///'),
          label: 'u',
          folders: [],
          requiresWorkspaceTrust: false,
          isVirtualWorkspace: true,
        };
      }
    }

    class Xfe {
      public readonly _sessionCache = new Map<string, unknown>();
      public readonly _sessionWrapperCache = new Map<string, unknown>();
      public readonly _newSessions = new Map<string, unknown>();
      public readonly _inFlightCommits = new Set<string>();
      public readonly _onDidChangeSessionTypes = { event: () => ({ dispose() {} }), fire: vi.fn() };
      public readonly onDidChangeSessionTypes = this._onDidChangeSessionTypes.event;
      public readonly _onDidChangeSessions = { event: () => ({ dispose() {} }), fire: vi.fn() };
      public readonly onDidChangeSessions = this._onDidChangeSessions.event;
      public readonly agentSessionsService = {
        model: {
          sessions: sessionsList,
          onDidChangeSessions: (cb: () => void) => {
            sessionListeners.add(cb);
            return { dispose: () => sessionListeners.delete(cb) };
          },
        },
      };
      public readonly chatService = {
        sendRequest: vi.fn(async (resource: unknown, query: string, opts: Record<string, unknown>) => {
          sentPayloads.push({ resource, query, opts });
          // Materialized intermediate untitled item should be skipped while send is in-flight.
          sessionsList.push({
            resource: makeUri('antigravity', '/untitled-ext'),
            providerType: 'antigravity',
            metadata: {},
          });
          for (const cb of [...sessionListeners]) cb();
          return {
            kind: 'sent',
            data: {
              responseCreatedPromise: Promise.resolve({ isCanceled: false }),
              responseCompletePromise: new Promise<void>((resolve) => {
                setTimeout(() => {
                  sessionsList.push({
                    resource: makeUri('antigravity', '/real-123'),
                    providerType: 'antigravity',
                    metadata: { workingDirectoryPath: 'd:\\project' },
                  });
                  for (const cb of [...sessionListeners]) cb();
                  resolve();
                }, 10);
              }),
            },
          };
        }),
      };
      public readonly chatSessionsService = {
        getChatSessionContribution: () => ({ type: 'antigravity' }),
        activateChatSessionItemProvider: vi.fn(async () => {}),
        getNewChatSessionInputState: vi.fn(async () => []),
        getOptionGroupsForSessionType: () => [],
        onDidChangeItemsProviders: () => ({ dispose() {} }),
        onDidChangeOptionGroups: () => ({ dispose() {} }),
      };
      public readonly languageModelsService = {
        getLanguageModelIds: () => [],
        lookupLanguageModel: () => undefined,
        onDidChangeLanguageModels: () => ({ dispose() {} }),
      };
      public readonly instantiationService = {
        createInstance: (Ctor: new (...a: unknown[]) => unknown, ...a: unknown[]) => new Ctor(...a),
      };

      public _register<T>(x: T): T {
        return x;
      }
      public resolveWorkspace(e: { scheme: string; fsPath?: string; path: string }) {
        if (e.scheme !== 'file') return undefined;
        return {
          uri: e,
          label: 'project',
          folders: [{ root: e, workingDirectory: e, name: 'project' }],
          requiresWorkspaceTrust: true,
          isVirtualWorkspace: false,
        };
      }
      public async _updateChatSessionState(resource: unknown, d: Draft): Promise<{ dispose: () => void }> {
        updatedOptions.push({ resource, options: new Map(d.selectedOptions) });
        return { dispose() {} };
      }
      public _clearCurrentNewSessionIfMatch(): void {}
      public async _waitForSessionInCache(res: { toString: () => string }): Promise<unknown> {
        return this._sessionCache.get(res.toString());
      }
      public _chatToSession(e: { sessionId: string; resource: unknown; icon: unknown; workspace?: unknown; mainChat: unknown }) {
        return {
          sessionId: e.sessionId,
          resource: e.resource,
          harness: 'copilot',
          icon: e.icon,
          workspace: e.workspace,
          mainChat: e.mainChat,
        };
      }
      public _replaceSession(payload: { from: unknown; to: unknown }): void {
        replacements.push(payload);
      }
      public _usesSandbox(): boolean {
        return true;
      }
      public _validateSandboxSession(): void {
        throw new Error('GitHub sandbox creation requires a repository for this session.');
      }
      public async sendRequest(sessionId: string, chatResource: unknown, opts: unknown) {
        const draft = this._newSessions.get(sessionId) as Draft | undefined;
        if (draft) {
          return this._usesSandbox()
            ? (this._validateSandboxSession(), undefined)
            : (this as unknown as { _sendFirstChat: (d: Draft, r: unknown, o: unknown) => Promise<unknown> })._sendFirstChat(
                draft,
                chatResource,
                opts,
              );
        }
        throw new Error(`Session '${sessionId}' not found`);
      }
    }

    const registered: unknown[] = [];
    const realized: Record<string, unknown> = await runInNewContext(
      `
      (async () => {
        let baseProv;
        ${providerSnippet}
        const folder = Uri.file('d:\\\\project');
        const created = agyProv._createDraftSession(folder, 'antigravity', {});
        const draft = agyProv._newSessions.get(created.sessionId);
        agyProv.setNewSessionModeOption(created, { id: 'auto', name: 'Auto' });
        const result = await agyProv.sendRequest(draft.sessionId, draft.resource, { query: 'Fix bug', attachedContext: [] });
        return result;
      })()
      `,
      {
        Xfe,
        Draft,
        CacheItem,
        Uri: {
          file: (p: string) => makeUri('file', p.replace(/\\/g, '/'), p),
          from: ({ scheme, path }: { scheme: string; path: string }) => makeUri(scheme, path),
        },
        uuid: () => 'draft-1',
        getModels: () => [],
        resolveModel: () => ({ kind: 'unavailable' }),
        svc: {},
        inst: {
          createInstance: (Ctor: new (...a: unknown[]) => unknown, ...a: unknown[]) => new Ctor(...a),
        },
        reg: {
          registerProvider: (p: unknown) => registered.push(p),
        },
        disp: {
          add: <T>(x: T) => x,
        },
        setTimeout,
        clearTimeout,
      },
    );

    expect(registered).toHaveLength(1);
    expect(updatedOptions[0]?.options.get('folder')).toBe('d:\\project');
    expect(updatedOptions[0]?.options.get('mode')).toEqual({ id: 'auto', name: 'Auto' });
    expect(sentPayloads[0]?.opts).toMatchObject({
      agentIdSilent: 'antigravity',
      userSelectedModelId: 'antigravity:gemini-2.5-pro',
    });
    expect(realized.harness).toBe('antigravity');
    expect((realized.resource as { path: string }).path).toBe('/real-123');
    expect(replacements).toHaveLength(1);
  });

  it('restores response details, timing, and modelTotals on history and live turn stats', () => {
    const history = [
      {
        type: 'response',
        parts: [
          {
            content: {
              value:
                '<!--AGY_USAGE:{"used":4200,"size":1000000,"completionTokens":200,"elapsedMs":1500,"completedAt":1700000001500,"responseDetails":"Gemini 4 Neon (High)","modelTotals":[{"model":"Gemini 4 Neon","inputTokens":4000,"cachedTokens":1000,"outputTokens":200}]}-->',
            },
          },
        ],
      },
    ];
    extractHistoryUsageParts(history, { scheme: 'antigravity' });
    expect(history[0]).toMatchObject({
      elapsedMs: 1500,
      completedAt: 1700000001500,
      details: 'Gemini 4 Neon (High)',
    });
    expect(history[0]?.parts[0]).toMatchObject({
      kind: 'usage',
      promptTokens: 4000,
      completionTokens: 200,
      modelTotals: [{ model: 'Gemini 4 Neon', inputTokens: 4000, cachedTokens: 1000, outputTokens: 200 }],
    });

    const setElapsedMs = vi.fn();
    const setUsage = vi.fn();
    const request = {
      response: {
        setElapsedMs,
        usage: { get: () => ({ kind: 'usage', promptTokens: 4000, completionTokens: 200 }) },
        setUsage,
      },
    };
    const snippet = buildLiveTurnStatsSnippet({ req: 'req', res: 'res' });
    runInNewContext(`(${snippet.slice(0, -1)})`, {
      req: request,
      res: {
        metadata: {
          __agyTurnStats: {
            elapsedMs: 2450,
            completedAt: 1700000002450,
            modelTotals: [{ model: 'Gemini 4 Neon', inputTokens: 4000, cachedTokens: 500, outputTokens: 200 }],
          },
        },
      },
    });
    expect(setElapsedMs).toHaveBeenCalledWith(2450);
    expect((request.response as { _completionTimestamp?: number })._completionTimestamp).toBe(1700000002450);
    expect(setUsage).toHaveBeenCalledWith({
      kind: 'usage',
      promptTokens: 4000,
      completionTokens: 200,
      modelTotals: [{ model: 'Gemini 4 Neon', inputTokens: 4000, cachedTokens: 500, outputTokens: 200 }],
    });

    // Also ensure direct helper ignores turns missing __agyTurnStats.
    applyLiveTurnStats({ response: { setElapsedMs: vi.fn() } }, { metadata: {} });
  });

  it('registers antigravity:/subagent/ child chats into AntigravityCacheSession._chatsObs for Split View', () => {
    const provider = {
      _sessionCache: new Map<string, Record<string, unknown>>(),
    };
    const obsValues = new Map<unknown, unknown>();
    class MockObs {
      public readonly _debugNameData = { label: 'mock' };
      public readonly _equalityComparator = Object.is;
      public constructor(
        _meta: unknown,
        private value: unknown,
        _eq?: unknown,
      ) {
        obsValues.set(this, value);
      }
      public get(): unknown {
        return this.value;
      }
      public set(next: unknown): void {
        this.value = next;
        obsValues.set(this, next);
      }
    }
    class MockCacheBase {
      public readonly resource: { scheme: string; path: string; toString: () => string };
      public readonly harness = 'antigravity';
      public readonly _defaultChat: Record<string, unknown>;
      public readonly _mainChatObs: MockObs;
      public readonly _chatsObs: MockObs;
      public readonly _aggregateChatResources = new Set<unknown>();
      public constructor(res: { scheme: string; path: string; toString: () => string }) {
        this.resource = res;
        this._defaultChat = {
          resource: res,
          harness: 'antigravity',
          createdAt: 1,
          workspace: undefined,
          updatedAt: new MockObs({}, 1),
          changes: new MockObs({}, []),
          changesets: new MockObs({}, []),
          changesSummary: new MockObs({}, {}),
          observeChanges: vi.fn(),
          modelId: new MockObs({}, undefined),
          modelSource: new MockObs({}, undefined),
          mode: new MockObs({}, 'default'),
          isArchived: new MockObs({}, false),
          interactivity: new MockObs({}, 'full'),
        };
        this._mainChatObs = new MockObs({}, this._defaultChat);
        this._chatsObs = new MockObs({}, [this._defaultChat]);
      }
      public update(): boolean {
        this._chatsObs.set([this._defaultChat]);
        return true;
      }
    }

    const ensureSnippet = buildSessionsSubagentOpenerSnippet({ arg: 'l', mgmt: 'e', hosts: 't' });
    const trackSnippet = buildSessionsSubagentTrackSnippet({ item: 'h' }, { mgmt: 'e', hosts: 't' });
    expect(ensureSnippet).toContain('antigravity.ensureSubagentChat');
    expect(trackSnippet).toContain('trackEnabled');

    const parentUri = {
      scheme: 'antigravity',
      path: '/parent-1',
      toString: () => 'antigravity:/parent-1',
    };
    const uriCtor = {
      parse: (raw: string) => {
        const idx = raw.indexOf(':');
        return { scheme: raw.slice(0, idx), path: raw.slice(idx + 1), toString: () => raw };
      },
    };
    Object.assign(parentUri, { constructor: uriCtor });

    // Extract just the ensure helper logic from buildSessionsProviderSnippet by checking the rendered provider code.
    const cacheSession = new MockCacheBase(parentUri) as MockCacheBase & {
      _agySubagentChats?: Map<string, Record<string, unknown>>;
      _ensureAgySubagentChat?: (res: string, title?: string) => Record<string, unknown> | undefined;
    };
    cacheSession._agySubagentChats = new Map();
    const providerSrc = buildSessionsProviderSnippet(
      { services: 's', inst: 'i', regSvc: 'r', disp: 'd', prov: 'p', xfeCls: 'Xfe' },
      { uriCls: 'Uri', uuidFn: 'uuid', draftCls: 'Draft', inst: 'inst' },
      { itemCls: 'MockCacheBase' },
      { getModels: 'getModels', resolveModel: 'resolveModel' },
    );
    expect(providerSrc).toContain('_ensureAgySubagentChat');
    expect(providerSrc).toContain('antigravity:/subagent/');

    // Smoke-check patch bundles reject unmatched fake strings rather than mutating unrelated code.
    expect(patchSessionsContent('not a bundle').ok).toBe(false);
    expect(patchWorkbenchContent('not a bundle').ok).toBe(false);
    expect(provider).toBeDefined();

    const roSnippet = buildSubagentReadOnlySnippet({ constObs: 'constObs' });
    const inputSnippet = buildSubagentSessionInputSnippet({ sess: 'sess' });
    const edSnippet = buildEditorEditingSessionSnippet({ loc: 'loc', model: 'model', transfer: 'transfer' });
    expect(roSnippet).toContain('subagentChatResource=');
    expect(roSnippet).toContain('constObs(!0)');
    expect(inputSnippet).toContain('inputState:void 0');
    expect(edSnippet).toContain('startEditingSession(!1,transfer)');
  });
});