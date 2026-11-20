const { validateSnippetSyntax } = require('./validate');

function renderSessionsQuota(parent, pools, setupModelHover) {
  const add = (target, tag, className, text) => {
    const node = target.ownerDocument.createElement(tag);
    node.className = `sessions-account-titlebar-panel-provider-${className}`;
    if (text !== undefined) node.textContent = text;
    return target.appendChild(node);
  };
  const addRow = (target, variant) => add(target, 'div', `metric-row ${variant}`);

  if (!Array.isArray(pools) || pools.length === 0) {
    add(addRow(parent, 'secondary'), 'span', 'reset', 'No quota pools reported yet.');
    return;
  }

  const groups = new Map();
  const percentFormat = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
  for (const pool of pools) {
    const label = pool.label || 'Quota';
    let group = groups.get(label);
    if (!group) {
      group = add(parent, 'div', 'usage');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      add(addRow(group, 'primary'), 'span', 'plan', label);
      groups.set(label, group);
    }

    const timing = [pool.windowLabel, pool.resetLabel].filter(Boolean).join(' · ') || 'Quota';
    const usage = Number.isFinite(pool.usedPercent)
      ? `${percentFormat.format(Math.max(0, Math.min(100, pool.usedPercent)) / 100)} used`
      : 'Usage unavailable';
    const row = addRow(group, 'secondary');
    add(row, 'span', 'reset', timing);
    add(row, 'span', 'usage-value', usage).style.fontVariantNumeric = 'tabular-nums';

    if (Array.isArray(pool.modelLabels) && pool.modelLabels.length > 0) {
      const models = `Models: ${pool.modelLabels.join(', ')}`;
      row.tabIndex = 0;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `${timing}, ${usage}. ${models}`);
      setupModelHover(row, models);
    }
  }
}

function buildSessionsPanelSnippet({ append, element }, { actionBar, action }, { chatStatusToken }) {
  const body = `(()=>{try{
const _agyCs=this.instantiationService.invokeFunction((_agyAcc)=>_agyAcc.get(${chatStatusToken}));
if(!_agyCs)return;
const _agyEntry=[..._agyCs.getEntries()].find((_agyX)=>_agyX&&(_agyX.id==="antigravity.providerAccount"||typeof _agyX.id==="string"&&_agyX.id.endsWith(".antigravity.providerAccount")));
if(!_agyEntry)return;
const _agyTip=typeof _agyEntry.tooltip==="string"?_agyEntry.tooltip:_agyEntry.tooltip?.value;
if(!_agyTip)return;
const _agyMatch=_agyTip.match(/<!--AGY_META:([\\s\\S]*?)-->/);
if(!_agyMatch)return;
const _agyMeta=JSON.parse(_agyMatch[1]);
const _agyAppend=${append},_agyElement=${element},_agyActionBar=${actionBar},_agyAction=${action};
if(!_agyMeta.signedIn){
  const _agySec=_agyAppend(l,_agyElement("section.sessions-account-titlebar-panel-provider-account.signed-out",{"aria-label":"Antigravity"}));
  const _agyId=_agyAppend(_agySec,_agyElement(".sessions-account-titlebar-panel-provider-identity"));
  _agyAppend(_agyId,_agyElement("span.sessions-account-titlebar-panel-provider-icon",{"aria-hidden":"true"})).classList.add("codicon","codicon-antigravity-logo");
  const _agySignInBox=_agyAppend(_agyId,_agyElement(".sessions-account-titlebar-panel-provider-sign-in-actions"));
  const _agyBar=e.add(new _agyActionBar(_agySignInBox));
  e.add(_agyBar.onWillRun(()=>{this.hoverService.hideHover(!0),this.clickPanelDisposable.clear()}));
  _agyBar.push(e.add(new _agyAction("antigravity.signIn","Sign in with Google","",!0,()=>this.commandService.executeCommand("antigravityHarness.signIn"))),{icon:!1,label:!0});
  return;
}
const _agySec=_agyAppend(l,_agyElement("section.sessions-account-titlebar-panel-provider-account",{"aria-label":"Antigravity"}));
const _agyId=_agyAppend(_agySec,_agyElement(".sessions-account-titlebar-panel-provider-identity"));
const _agyAvatar=_agyMeta.profilePictureUrl||_agyMeta.avatarUrl;
if(_agyAvatar){
  const _agyImg=_agyAppend(_agyId,_agyElement("img.sessions-account-titlebar-panel-provider-avatar",{alt:_agyMeta.email||"Antigravity",draggable:"false",src:_agyAvatar}));
  _agyImg.decoding="async";_agyImg.referrerPolicy="no-referrer";
  const _agyIco=_agyAppend(_agyId,_agyElement("span.sessions-account-titlebar-panel-provider-icon.hidden",{"aria-hidden":"true"}));
  _agyIco.classList.add("codicon","codicon-antigravity-logo");
  _agyImg.onerror=()=>{_agyImg.classList.add("hidden");_agyIco.classList.remove("hidden")};
}else{
  _agyAppend(_agyId,_agyElement("span.sessions-account-titlebar-panel-provider-icon",{"aria-hidden":"true"})).classList.add("codicon","codicon-antigravity-logo");
}
const _agyName=_agyAppend(_agyId,_agyElement("div.sessions-account-titlebar-panel-provider-name"));
_agyName.textContent=_agyMeta.email||_agyMeta.displayName||"Antigravity";
const _agyAct=_agyAppend(_agyId,_agyElement(".sessions-account-titlebar-panel-provider-actions"));
const _agyBar=e.add(new _agyActionBar(_agyAct));
e.add(_agyBar.onWillRun(()=>{this.hoverService.hideHover(!0),this.clickPanelDisposable.clear()}));
_agyBar.push(e.add(new _agyAction("antigravity.openSettings","Open Harness Settings","codicon codicon-settings-gear",!0,()=>this.commandService.executeCommand("antigravityHarness.openSettings"))),{icon:!0,label:!1});
const _agyUsage=_agyAppend(_agySec,_agyElement(".sessions-account-titlebar-panel-provider-usage"));
const _agyPri=_agyAppend(_agyUsage,_agyElement(".sessions-account-titlebar-panel-provider-metric-row.primary"));
_agyAppend(_agyPri,_agyElement("span.sessions-account-titlebar-panel-provider-plan",void 0,_agyMeta.tierName||"Google Antigravity"));
(${renderSessionsQuota.toString()})(_agyUsage,_agyMeta.pools,(_agyRow,_agyModels)=>{
  e.add(this.hoverService.setupDelayedHover(_agyRow,{content:_agyModels},{setupKeyboardEvents:!0}));
});
}catch{}})();`.replace(/\r?\n\s*/g, '');

  const check = validateSnippetSyntax(body, '(function(l,e){', '})', 'sessions-panel');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

function buildSessionsSkipContributedSnippet() {
  const body =
    'if(t&&(t.id==="antigravity.providerAccount"||typeof t.id==="string"&&t.id.endsWith(".antigravity.providerAccount")))continue;';
  const check = validateSnippetSyntax(body, '(function(e){for(let t of e){', '}})', 'sessions-skip-contributed');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

module.exports = { buildSessionsPanelSnippet, buildSessionsSkipContributedSnippet };
