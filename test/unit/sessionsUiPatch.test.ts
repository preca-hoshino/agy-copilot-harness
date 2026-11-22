import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { QuotaPoolSummary } from '../../src/shared/contracts.js';

const requireFromProject = createRequire(`${process.cwd()}/package.json`);
const { createTerminalApproval, extractHistoryUsageParts, renderQuotaGroups, renderQuotaRow } = requireFromProject('./scripts/patch-sessions-ui.js');
const { buildSessionsPanelSnippet } = requireFromProject('./scripts/ui-patch/snippets/sessions-panel.js');
const {
  buildEditingActionNotifySnippet,
  buildExternalEditBaselineSnippet,
  buildLiveEditPillSnippet,
  buildSideChatSessionSnippet,
  buildWorkingSetDedupSnippet,
} = requireFromProject('./scripts/ui-patch/snippets/working-set.js');

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
    const reqModel: { _responseParts: Array<Record<string, unknown>>; __agyBeforeUris?: Map<string, FakeUri> } = {
      _responseParts: [streamingTool],
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
  });

  it('deduplicates session.changes against live ChatEditingSession entries for antigravity only', () => {
    const snippet = buildWorkingSetDedupSnippet({ arg1: 't', arg2: 'i', arg3: 'n' });
    const fn = runInNewContext(`(function(e,t,i,n){${snippet}return{session:i.read(null),live:n.read(null)};})`);

    const agyRes = fn(
      null,
      { chatSessionResource: { scheme: 'antigravity' } },
      { read: () => [{ reference: 'file:///a.ts' }, { reference: 'file:///b.ts' }] },
      { read: () => [{ reference: 'file:///a.ts' }] },
    );
    expect(agyRes.session).toEqual([{ reference: 'file:///b.ts' }]);

    const copilotRes = fn(
      null,
      { chatSessionResource: { scheme: 'copilotcli' } },
      { read: () => [{ reference: 'file:///a.ts' }] },
      { read: () => [{ reference: 'file:///a.ts' }] },
    );
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