const { SESSIONS_ANCHORS, WORKBENCH_ANCHORS, resolveAnchors } = require('./anchors');
const { markSnippet, reattachFooter } = require('./markers');
const { buildTrustedAuthAccessSnippet, buildWorkbenchAccountsOrderSnippet } = require('./snippets/accounts');
const { buildModePermissionsPickerSnippet } = require('./snippets/mode-permissions-picker');
const { buildSessionsPanelSnippet, buildSessionsSkipContributedSnippet } = require('./snippets/sessions-panel');
const { buildSessionHistoryUsageSnippet } = require('./snippets/session-usage');
const { buildStatusBarTooltipSnippet } = require('./snippets/status-tooltip');
const { buildTerminalApprovalSnippet } = require('./snippets/terminal-approval');
const {
  buildEditingActionNotifySnippet,
  buildExternalEditBaselineSnippet,
  buildLiveEditPillSnippet,
  buildSideChatSessionSnippet,
  buildWorkingSetDedupSnippet,
} = require('./snippets/working-set');

function insertSnippets(patch, insertions) {
  // Apply from right to left so the original anchor offsets stay valid.
  let next = patch.clean;
  for (const [offset, hook, snippet] of insertions.sort(([left], [right]) => right - left)) {
    next = next.slice(0, offset) + markSnippet(hook, patch.baseHash, snippet) + next.slice(offset);
  }
  return reattachFooter(patch, next);
}

function commonInsertions(matches) {
  const { sessionHarnessIcon, sessionDelegation } = matches;
  const { session, icon } = sessionHarnessIcon.groups;
  const { type } = sessionDelegation.groups;
  return [
    [matches.statusBar.end, 'status-bar', buildStatusBarTooltipSnippet('status bar tooltip')],
    [matches.trustedAuth.end, 'trusted-auth', buildTrustedAuthAccessSnippet('trusted auth')],
    [matches.terminalApproval.end, 'terminal-approval', buildTerminalApprovalSnippet(matches.terminalInvocation.groups, matches.sessionType.groups)],
    // VS Code 1.147 drops controller icons in transit; override even the cached terminal fallback.
    [sessionHarnessIcon.end, 'session-harness-icon', `if(${session}.providerType==="antigravity")${icon}={id:"antigravity-logo"};`],
    // Use VS Code's native delegation gate; canDelegate still allows starting new Antigravity sessions.
    [sessionDelegation.end, 'session-delegation', `if(${type}==="antigravity")return false;`],
    [matches.sessionHistoryUsage.end, 'session-history-usage', buildSessionHistoryUsageSnippet()],
    [matches.externalEditBaseline.end, 'external-edit-baseline', buildExternalEditBaselineSnippet(matches.externalEditBaseline.groups)],
    [matches.liveEditPill.end, 'live-edit-pill', buildLiveEditPillSnippet(matches.liveEditPill.groups)],
    [matches.workingSetDedup.end, 'working-set-dedup', buildWorkingSetDedupSnippet(matches.workingSetDedup.groups)],
    [matches.editingActionNotify.end, 'editing-action-notify', buildEditingActionNotifySnippet(matches.editingActionNotify.groups)],
    [matches.sideChatSession.end, 'side-chat-session', buildSideChatSessionSnippet(matches.sideChatSession.groups)],
    [matches.modePermissionsPicker.end, 'mode-permissions-picker', buildModePermissionsPickerSnippet(matches.modePermissionsPicker.groups)],
  ];
}

function patchSessions(patch) {
  if (!patch.ok) return patch;
  const result = resolveAnchors(patch.clean, SESSIONS_ANCHORS);
  if (!result.ok) return result;
  const { matches } = result;
  const { panel, panelMethod, panelDom, panelActions, chatStatus, contributed } = matches;
  if (!(panelMethod.end <= panelDom.start && panelDom.end <= panelActions.start && panelActions.end <= panel.start)) {
    return { ok: false, reason: 'Sessions account panel helpers are not in the expected order.' };
  }

  const content = insertSnippets(patch, [
    ...commonInsertions(matches),
    [panel.start, 'sessions-panel', buildSessionsPanelSnippet(panelDom.groups, panelActions.groups, chatStatus.groups)],
    [contributed.end, 'sessions-contributed', buildSessionsSkipContributedSnippet()],
  ]);
  return { ok: true, content };
}

function patchWorkbench(patch) {
  if (!patch.ok) return patch;
  const result = resolveAnchors(patch.clean, WORKBENCH_ANCHORS);
  if (!result.ok) return result;
  const { matches } = result;
  const content = insertSnippets(patch, [
    ...commonInsertions(matches),
    [matches.accounts.end, 'accounts-order', buildWorkbenchAccountsOrderSnippet(matches.accounts.groups)],
  ]);
  return { ok: true, content };
}

module.exports = { patchSessions, patchWorkbench };
