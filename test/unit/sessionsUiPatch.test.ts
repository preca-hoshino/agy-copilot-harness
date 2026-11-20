import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { QuotaPoolSummary } from '../../src/shared/contracts.js';

const requireFromProject = createRequire(`${process.cwd()}/package.json`);
const { createTerminalApproval, renderQuotaGroups, renderQuotaRow } = requireFromProject('./scripts/patch-sessions-ui.js');
const { buildSessionsPanelSnippet } = requireFromProject('./scripts/ui-patch/snippets/sessions-panel.js');

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