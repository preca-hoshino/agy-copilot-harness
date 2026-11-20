import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const { createTerminalApproval, renderQuotaGroups, renderQuotaRow } = createRequire(`${process.cwd()}/package.json`)(
  './scripts/patch-sessions-ui.js',
);

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
  public className = '';
  public textContent = '';

  public appendChild(child: FakeNode): FakeNode { this.children.push(child); return child; }
  public append(child: FakeNode, text: string): void { this.appendChild(child); this.textContent = text; }
  public setAttribute(): void {}
  public child(name: string): FakeNode | undefined { return this.children.find((child) => child.className === name); }
}

it('renders one heading per quota group while retaining each cycle and its own width', () => {
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