const { validateSnippetSyntax } = require('./validate');

function createTerminalApproval(progress, requestId, response, Invocation, source, sendAnswer) {
  const question = progress.questions?.[0];
  if (!question?.id?.startsWith('agy-terminal:') || typeof progress.resolveId !== 'string' || response.isComplete) return;
  let data;
  try {
    data = JSON.parse(question.id.slice('agy-terminal:'.length));
  } catch {
    return;
  }
  if (!data || typeof data.command !== 'string' || !data.command.trim() || !Array.isArray(data.options)) return;
  const options = question.options?.flatMap((entry) => {
    const option = data.options.find((item) => item.optionId === entry.id && entry.value === entry.id);
    if (!option || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)) return [];
    return [{ id: entry.id, label: entry.label, kind: option.kind.startsWith('allow_') ? 'approve' : 'deny', scope: option.kind }];
  }) ?? [];
  const skip = options.find((option) => option.scope === 'reject_once');
  const allowDefault = options.find((option) => option.scope === 'allow_once') ?? options.find((option) => option.kind === 'approve');
  if (!options.length) return;
  const customOptions = skip ? options : [...options, { id: '', label: 'Skip', kind: 'deny' }];
  const toolId = 'antigravity_terminal_confirmation';
  const invocation = new Invocation({
    invocationMessage: 'Run in terminal',
    presentation: 'hiddenAfterComplete',
    confirmationMessages: {
      title: 'Run in terminal?',
      ...(typeof data.cwd === 'string' ? { message: `Working directory: ${data.cwd}` } : {}),
      customOptions,
    },
    toolSpecificData: { kind: 'terminal', commandLine: { original: data.command }, editable: false, language: 'shellscript' },
  }, { id: toolId, source, displayName: 'Antigravity', modelDescription: 'Terminal confirmation' },
  `agy-terminal-${progress.resolveId}`, undefined, undefined, {}, requestId);
  const state = invocation.state.get();
  const confirm = state.confirm;
  let settled = false;
  const subscription = response.onDidChange(() => {
    if (response.isComplete && !settled) {
      settled = true;
      subscription.dispose();
      invocation.didCancelTool({ type: 5 });
    }
  });
  state.confirm = (reason) => {
    if (settled || response.isComplete) return;
    settled = true;
    subscription.dispose();
    const selected = reason.type === 4
      ? (reason.selectedButton !== undefined
          ? options.find((option) => option.id === reason.selectedButton)
          : allowDefault)
      : (reason.type === 5 || reason.type === 0) ? skip : undefined;
    if (selected?.kind === 'approve') {
      confirm(reason);
      void invocation.didExecuteTool({ content: [] });
    } else {
      confirm({ type: 5 });
    }
    void sendAnswer(requestId, progress.resolveId, selected ? { [question.id]: selected.id } : undefined);
  };
  return invocation;
}

function buildTerminalApprovalSnippet({ invocation, source }, { sessionType }) {
  const body = `if(p.kind==="questionCarousel"&&p.questions?.length===1&&l&&r?.sessionResource&&${sessionType}(r.sessionResource)==="antigravity"){
    const _agyApproval=(${createTerminalApproval.toString()})(p,e,l,${invocation},${source}.External,(...args)=>this._proxy.$handleQuestionCarouselAnswer(...args));
    if(_agyApproval){c.push(_agyApproval);continue;}
  }`;
  const check = validateSnippetSyntax(body, '(function(){for(;;){', '}})', 'terminal approval');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

module.exports = { buildTerminalApprovalSnippet, createTerminalApproval };
