#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const PATCH_START = '/*AGY_HARNESS_PATCH_START*/';
const PATCH_END = '/*AGY_HARNESS_PATCH_END*/';
const MARKER_REGEX = /\/\*AGY_HARNESS_PATCH_START\*\/[\s\S]*?\/\*AGY_HARNESS_PATCH_END\*\//g;

const ANCHOR_SESSIONS_PANEL =
  'if(this.chatEntitlementService.sentiment.hidden||e.add(this.instantiationService.createInstance(';
const ANCHOR_RENDER_CONTRIBUTED = 'renderContributedSections(e){for(let t of e){';
const ANCHOR_STATUSBAR_WORKBENCH =
  'let r=ds(n)?{markdown:n,markdownNotSupportedFallback:void 0}:n;this.hover?this.hover.update(r,i):this.hover=this._register(this.hoverService.setupManagedHover(this.hoverDelegate,this.container,r,i))';
const ANCHOR_STATUSBAR_SESSIONS =
  'let r=Xs(n)?{markdown:n,markdownNotSupportedFallback:void 0}:n;this.hover?this.hover.update(r,i):this.hover=this._register(this.hoverService.setupManagedHover(this.hoverDelegate,this.container,r,i))';
const ANCHOR_READ_ALLOWED_EXTENSIONS =
  'readAllowedExtensions(e,t){let i=[];try{let a=this._storageService.get(`${e}-${t}`,-1);a&&(i=JSON.parse(a))}catch{}let n=this._productService.trustedExtensionAuthAccess,r=Array.isArray(n)?n:typeof n=="object"?n[e]??[]:[];';
const ANCHOR_WORKBENCH_ACCOUNTS_MENU =
  'if(h.length){r.length&&r.push(new ri);for(let g of h)r.push(g instanceof Xe?t.add(g):g)}return p(u),r';
const ANCHOR_TERMINAL_APPROVAL = 'for(let u of t){let[p,h]=Array.isArray(u)?u:[u];if(p.kind==="externalEdits")';
const TERMINAL_APPROVAL_PREFIX = 'for(let u of t){let[p,h]=Array.isArray(u)?u:[u];';

function stripPatchMarkers(content) {
  return content.replace(MARKER_REGEX, '');
}

function countPatchMarkers(content) {
  const matches = content.match(/\/\*AGY_HARNESS_PATCH_START\*\//g);
  return matches ? matches.length : 0;
}

function assertUniqueAnchor(content, anchor, label) {
  const parts = content.split(anchor);
  if (parts.length === 1) {
    return { ok: false, reason: `Anchor not found: ${label}` };
  }
  if (parts.length > 2) {
    return { ok: false, reason: `Anchor matched ${parts.length - 1} times (expected 1): ${label}` };
  }
  return { ok: true };
}

function validateSnippetSyntax(code, wrapperPrefix, wrapperSuffix, label) {
  try {
    new vm.Script(`${wrapperPrefix}${code}${wrapperSuffix}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Syntax validation failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function detectChatStatusItemToken(sessionsContent) {
  const match = /\b([A-Za-z0-9_$]+)=fe\("chatStatusItemService"\)/.exec(sessionsContent);
  return match?.[1] ? match[1] : 'Tqt';
}

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
      ? options.find((option) => option.id === reason.selectedButton)
      : reason.type === 0 ? skip : undefined;
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

function patchTerminalApproval(content, invocation, source, sessionType) {
  const anchor = assertUniqueAnchor(content, ANCHOR_TERMINAL_APPROVAL, 'MainThreadChatAgents2 terminal approval');
  if (!anchor.ok) return anchor;
  const body = `if(p.kind==="questionCarousel"&&p.questions?.length===1&&l&&r?.sessionResource&&${sessionType}(r.sessionResource)==="antigravity"){
    const _agyApproval=(${createTerminalApproval.toString()})(p,e,l,${invocation},${source}.External,(...args)=>this._proxy.$handleQuestionCarouselAnswer(...args));
    if(_agyApproval){c.push(_agyApproval);continue;}
  }`;
  const check = validateSnippetSyntax(body, '(function(){for(;;){', '}})', 'terminal approval');
  if (!check.ok) return check;
  return { ok: true, content: content.replace(ANCHOR_TERMINAL_APPROVAL, () =>
    `${TERMINAL_APPROVAL_PREFIX}${PATCH_START}${body}${PATCH_END}${ANCHOR_TERMINAL_APPROVAL.slice(TERMINAL_APPROVAL_PREFIX.length)}`) };
}

function renderQuotaRow(parent, pool) {
  const add = (target, className, text) => {
    const node = target.ownerDocument.createElement('div');
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return target.appendChild(node);
  };
  const percent = Number.isFinite(pool.usedPercent) ? Math.round(Math.max(0, Math.min(100, pool.usedPercent))) : undefined;
  const row = add(parent, 'agy-quota-row');
  row.style.cssText = 'display:grid;gap:5px;margin-block:8px 4px;min-width:0';
  const header = add(row, 'agy-quota-header');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:2px 12px';
  const timing = [pool.windowLabel, pool.resetLabel].filter(Boolean).join(' · ');
  add(header, 'agy-quota-timing', timing || 'Quota').style.cssText = 'flex:1 1 10em;color:var(--vscode-descriptionForeground)';
  const value = add(header, 'agy-quota-value');
  value.style.cssText = 'margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums';
  if (percent === undefined) {
    value.textContent = 'Usage unavailable';
  } else {
    const number = value.ownerDocument.createElement('strong');
    number.style.cssText = 'font-size:1.65em;line-height:1.15';
    number.textContent = `${percent}%`;
    value.append(number, ' used');
  }
  if (percent !== undefined) {
    const track = add(row, 'agy-quota-track');
    track.setAttribute('aria-hidden', 'true');
    track.style.cssText = 'direction:ltr;display:block;width:100%;height:4px;overflow:hidden;border-radius:2px;background:var(--vscode-editorWidget-border,#7776)';
    const fill = add(track, 'agy-quota-fill');
    fill.style.cssText = 'display:block;height:100%;background:var(--vscode-progressBar-background,#3794ff)';
    fill.style.width = `${percent}%`;
  }
  return row;
}

function renderQuotaGroups(parent, pools, renderRow, onRow) {
  const groups = new Map();
  for (const pool of pools) {
    const label = pool.label || 'Quota';
    let group = groups.get(label);
    if (!group) {
      group = parent.ownerDocument.createElement('section');
      group.className = 'agy-quota-group';
      group.style.marginBlock = '12px 4px';
      const title = parent.ownerDocument.createElement('h3');
      title.className = 'agy-quota-name';
      title.style.cssText = 'font-size:1.25em;font-weight:600;margin:0;overflow-wrap:anywhere';
      title.textContent = label;
      group.appendChild(title);
      parent.appendChild(group);
      groups.set(label, group);
    }
    onRow(renderRow(group, pool), pool);
  }
}

function buildSessionsPanelSnippet(chatStatusToken) {
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
const _agyRender=${renderQuotaRow.toString()};
if(!_agyMeta.signedIn){
  const _agySec=_(l,T("section.sessions-account-titlebar-panel-provider-account.signed-out",{"aria-label":"Antigravity"}));
  const _agyId=_(_agySec,T(".sessions-account-titlebar-panel-provider-identity"));
  _(_agyId,T("span.sessions-account-titlebar-panel-provider-icon",{"aria-hidden":"true"})).classList.add("codicon","codicon-antigravity-logo");
  const _agySignInBox=_(_agyId,T(".sessions-account-titlebar-panel-provider-sign-in-actions"));
  const _agyBar=e.add(new Zo(_agySignInBox));
  e.add(_agyBar.onWillRun(()=>{this.hoverService.hideHover(!0),this.clickPanelDisposable.clear()}));
  _agyBar.push(e.add(new st("antigravity.signIn","Sign in with Google","",!0,()=>this.commandService.executeCommand("antigravityHarness.signIn"))),{icon:!1,label:!0});
  return;
}
const _agySec=_(l,T("section.sessions-account-titlebar-panel-provider-account",{"aria-label":"Antigravity"}));
const _agyId=_(_agySec,T(".sessions-account-titlebar-panel-provider-identity"));
const _agyAvatar=_agyMeta.profilePictureUrl||_agyMeta.avatarUrl;
if(_agyAvatar){
  const _agyImg=_(_agyId,T("img.sessions-account-titlebar-panel-provider-avatar",{alt:_agyMeta.email||"Antigravity",draggable:"false",src:_agyAvatar}));
  _agyImg.decoding="async";_agyImg.referrerPolicy="no-referrer";
  const _agyIco=_(_agyId,T("span.sessions-account-titlebar-panel-provider-icon.hidden",{"aria-hidden":"true"}));
  _agyIco.classList.add("codicon","codicon-antigravity-logo");
  _agyImg.onerror=()=>{_agyImg.classList.add("hidden");_agyIco.classList.remove("hidden")};
}else{
  _(_agyId,T("span.sessions-account-titlebar-panel-provider-icon",{"aria-hidden":"true"})).classList.add("codicon","codicon-antigravity-logo");
}
const _agyName=_(_agyId,T("div.sessions-account-titlebar-panel-provider-name"));
_agyName.textContent=_agyMeta.email||_agyMeta.displayName||"Antigravity";
const _agyAct=_(_agyId,T(".sessions-account-titlebar-panel-provider-actions"));
const _agyBar=e.add(new Zo(_agyAct));
e.add(_agyBar.onWillRun(()=>{this.hoverService.hideHover(!0),this.clickPanelDisposable.clear()}));
_agyBar.push(e.add(new st("antigravity.openSettings","Open Harness Settings",ne.asClassName(A.settingsGear),!0,()=>this.commandService.executeCommand("antigravityHarness.openSettings"))),{icon:!0,label:!1});
const _agyUsage=_(_agySec,T(".sessions-account-titlebar-panel-provider-usage"));
const _agyPri=_(_agyUsage,T(".sessions-account-titlebar-panel-provider-metric-row.primary"));
_(_agyPri,T("span.sessions-account-titlebar-panel-provider-plan",void 0,_agyMeta.tierName||"Google Antigravity"));
const _agyPools=Array.isArray(_agyMeta.pools)?_agyMeta.pools:[];
if(_agyPools.length===0){
  const _agyRow=_(_agyUsage,T(".sessions-account-titlebar-panel-provider-metric-row.secondary"));
  _(_agyRow,T("span.sessions-account-titlebar-panel-provider-reset",void 0,_agyMeta.errorMessage||"Quota status"));
  _(_agyRow,T("span.sessions-account-titlebar-panel-provider-usage-value",void 0,"Ready"));
}else{
  (${renderQuotaGroups.toString()})(_agyUsage,_agyPools,_agyRender,(_agyRow,_agyPl)=>{
    if(_agyPl.modelLabels?.length){
      _agyRow.tabIndex=0;
      e.add(this.hoverService.setupDelayedHover(_agyRow,{content:\`Models: \${_agyPl.modelLabels.join(", ")}\`},{setupKeyboardEvents:!0}));
    }
  });
}
}catch{}})();`.replace(/\n\s*/g, '');

  const check = validateSnippetSyntax(body, '(function(l,e){', '})', 'sessions-panel');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return `${PATCH_START}${body}${PATCH_END}`;
}

function buildSessionsSkipContributedSnippet() {
  const body =
    'if(t&&(t.id==="antigravity.providerAccount"||typeof t.id==="string"&&t.id.endsWith(".antigravity.providerAccount")))continue;';
  const check = validateSnippetSyntax(body, '(function(e){for(let t of e){', '}})', 'sessions-skip-contributed');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return `${PATCH_START}${body}${PATCH_END}`;
}

function buildStatusBarTooltipSnippet(label) {
  const body = `if(e&&e.extensionId==="antigravity.agy-copilot-harness"){
const _agyTip=typeof n==="string"?n:n?.value;
const _agyM=_agyTip?_agyTip.match(/<!--AGY_META:([\\s\\S]*?)-->/):null;
if(_agyM){
  let _agyMeta;
  try{_agyMeta=JSON.parse(_agyM[1])}catch{}
  if(_agyMeta){
    const _agySelf=this;
    r={element:(_agyTok)=>{
      const _agyDisps=[];
      _agyTok?.onCancellationRequested?.(()=>{for(const _d of _agyDisps)_d?.dispose?.()});
      const _agyDoc=_agySelf.container.ownerDocument;
      const _agyEl=(_tag,_cls,_text)=>{
        const _n=_agyDoc.createElement(_tag);
        if(_cls)_n.className=_cls;
        if(_text!==undefined)_n.textContent=String(_text);
        return _n;
      };
      const _agyRoot=_agyEl("div","chat-status-bar-entry-tooltip codex-status-bar-entry-tooltip");
      const _agyHdr=_agyRoot.appendChild(_agyEl("div","header codex-account-header"));
      const _agyAv=_agyMeta.profilePictureUrl||_agyMeta.avatarUrl;
      if(_agyMeta.signedIn&&_agyAv){
        const _agyImg=_agyHdr.appendChild(_agyEl("img","codex-account-avatar"));
        _agyImg.alt=_agyMeta.email||"Antigravity";
        _agyImg.draggable=!1;
        _agyImg.decoding="async";
        _agyImg.referrerPolicy="no-referrer";
        _agyImg.src=_agyAv;
        const _agyFallback=_agyHdr.appendChild(_agyEl("span","codex-account-icon codicon codicon-antigravity-logo"));
        _agyFallback.style.display="none";
        _agyFallback.setAttribute("aria-hidden","true");
        _agyImg.onerror=()=>{_agyImg.style.display="none";_agyFallback.style.display=""};
      }else{
        const _agyIco=_agyHdr.appendChild(_agyEl("span","codex-account-icon codicon codicon-antigravity-logo"));
        _agyIco.setAttribute("aria-hidden","true");
      }
      const _agyDet=_agyHdr.appendChild(_agyEl("div","codex-account-details"));
      const _agyEmail=_agyMeta.signedIn?(_agyMeta.email||_agyMeta.displayName||"Antigravity"):"Google Antigravity";
      const _agyPlan=_agyMeta.signedIn?(_agyMeta.tierName||"Google Antigravity"):"Not signed in";
      const _agyEmailEl=_agyDet.appendChild(_agyEl("span","codex-account-email",_agyEmail));
      const _agyPlanEl=_agyDet.appendChild(_agyEl("span","codex-account-plan",_agyPlan));
      _agyDisps.push(_agySelf.hoverService.setupDelayedHover(_agyEmailEl,{content:_agyEmail}));
      _agyDisps.push(_agySelf.hoverService.setupDelayedHover(_agyPlanEl,{content:_agyPlan}));
      const _agyAb=_agyHdr.appendChild(_agyEl("div","monaco-action-bar"));
      const _agyUl=_agyAb.appendChild(_agyEl("ul","actions-container"));
      _agyUl.setAttribute("role","toolbar");
      const _agyLi=_agyUl.appendChild(_agyEl("li","action-item"));
      _agyLi.setAttribute("role","presentation");
      const _agyBtn=_agyLi.appendChild(_agyEl("a","action-label codicon codicon-settings-gear"));
      _agyBtn.setAttribute("role","button");
      _agyBtn.tabIndex=0;
      _agyBtn.setAttribute("aria-label","Open Harness Settings");
      _agyDisps.push(_agySelf.hoverService.setupDelayedHover(_agyBtn,{content:"Open Harness Settings"}));
      const _agyRunSettings=(_ev)=>{
        _ev?.preventDefault?.();
        _ev?.stopPropagation?.();
        _agySelf.hoverService.hideHover(!0);
        _agySelf.commandService.executeCommand("antigravityHarness.openSettings");
      };
      _agyBtn.addEventListener("click",_agyRunSettings);
      _agyBtn.addEventListener("keydown",(_ev)=>{if(_ev.key==="Enter"||_ev.key===" ")_agyRunSettings(_ev)});
      if(!_agyMeta.signedIn){
        const _agyDesc=_agyRoot.appendChild(_agyEl("div","description"));
        const _agySignLink=_agyDesc.appendChild(_agyEl("a",void 0,"Sign in with Google"));
        _agySignLink.href="#";
        _agySignLink.style.cursor="pointer";
        _agySignLink.addEventListener("click",(_ev)=>{
          _ev.preventDefault();
          _agySelf.hoverService.hideHover(!0);
          _agySelf.commandService.executeCommand("antigravityHarness.signIn");
        });
        return _agyRoot;
      }
      const _agyPools=Array.isArray(_agyMeta.pools)?_agyMeta.pools:[];
      if(_agyPools.length===0){
        _agyRoot.appendChild(_agyEl("div","description","No quota pools reported yet."));
        return _agyRoot;
      }
      const _agyRender=${renderQuotaRow.toString()};
      (${renderQuotaGroups.toString()})(_agyRoot,_agyPools,_agyRender,(_agyInd,_agyPl)=>{
        if(Array.isArray(_agyPl.modelLabels)&&_agyPl.modelLabels.length>0){
          _agyDisps.push(_agySelf.hoverService.setupDelayedHover(_agyInd,{content:\`Models: \${_agyPl.modelLabels.join(", ")}\`}));
        }
      });
      return _agyRoot;
    }};
  }
}
}`.replace(/\n\s*/g, '');

  const check = validateSnippetSyntax(body, '(function(e,n){let r=n;', '})', label);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return `${PATCH_START}${body}${PATCH_END}`;
}

function buildTrustedAuthAccessSnippet(label) {
  const body =
    'if(e==="google-antigravity"&&!r.includes("antigravity.agy-copilot-harness"))r=[...r,"antigravity.agy-copilot-harness"];';
  const check = validateSnippetSyntax(body, '(function(e){let r=[];', '})', label);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return `${PATCH_START}${body}${PATCH_END}`;
}

function buildWorkbenchAccountsOrderSnippet() {
  const body = `try{
const _agyAcc=this.groupedAccounts?.get?.("google-antigravity");
let _agyLbl;
try{_agyLbl=this.authenticationService.getProvider("google-antigravity").label}catch{}
if(_agyLbl&&(Array.isArray(_agyAcc)&&_agyAcc.length>0||this.problematicProviders?.has?.("google-antigravity"))){
  const _agyNames=new Set((_agyAcc||[]).map((_x)=>\`\${_x.label} (\${_agyLbl})\`));
  const _agyMoved=[];
  const _agyRest=[];
  for(const _act of r){
    const _isAgy=_act&&(_act.id==="activitybar.submenu"&&_agyNames.has(_act.label)||_act.id==="providerUnavailable"&&typeof _act.label==="string"&&_act.label.includes(_agyLbl));
    if(_isAgy)_agyMoved.push(_act);
    else _agyRest.push(_act);
  }
  if(_agyMoved.length>0){
    while(_agyRest.length>0&&_agyRest[0]instanceof ri)_agyRest.shift();
    const _agyCleaned=[];
    for(const _act of _agyRest){
      if(_act instanceof ri&&(_agyCleaned.length===0||_agyCleaned[_agyCleaned.length-1]instanceof ri))continue;
      _agyCleaned.push(_act);
    }
    if(h.length===0&&_agyCleaned.length>0&&!(_agyCleaned[_agyCleaned.length-1]instanceof ri))_agyCleaned.push(new ri);
    _agyCleaned.push(..._agyMoved);
    r=_agyCleaned;
  }
}
}catch{}`.replace(/\n\s*/g, '');

  const check = validateSnippetSyntax(body, '(function(r,h,ri){', 'return r;})', 'workbench-accounts-order');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return `${PATCH_START}${body}${PATCH_END}`;
}

function patchSessionsContent(rawContent) {
  const cleanContent = stripPatchMarkers(rawContent);
  const a1 = assertUniqueAnchor(cleanContent, ANCHOR_SESSIONS_PANEL, 'Wei.createCombinedPanelContent');
  if (!a1.ok) {
    return a1;
  }
  const a2 = assertUniqueAnchor(cleanContent, ANCHOR_RENDER_CONTRIBUTED, 'W4.renderContributedSections');
  if (!a2.ok) {
    return a2;
  }
  const a3 = assertUniqueAnchor(cleanContent, ANCHOR_STATUSBAR_SESSIONS, 'Gtt.updateStatusBarTooltip');
  if (!a3.ok) {
    return a3;
  }
  const a4 = assertUniqueAnchor(cleanContent, ANCHOR_READ_ALLOWED_EXTENSIONS, 'AuthenticationAccessService.readAllowedExtensions');
  if (!a4.ok) {
    return a4;
  }

  const chatStatusToken = detectChatStatusItemToken(cleanContent);
  const panelSnippet = buildSessionsPanelSnippet(chatStatusToken);
  const skipContributedSnippet = buildSessionsSkipContributedSnippet();
  const statusBarSnippet = buildStatusBarTooltipSnippet('sessions-statusbar');
  const trustedAuthSnippet = buildTrustedAuthAccessSnippet('sessions-trusted-auth');

  let next = cleanContent.replace(ANCHOR_SESSIONS_PANEL, `${panelSnippet}${ANCHOR_SESSIONS_PANEL}`);
  next = next.replace(ANCHOR_RENDER_CONTRIBUTED, `${ANCHOR_RENDER_CONTRIBUTED}${skipContributedSnippet}`);
  const sbPrefix = 'let r=Xs(n)?{markdown:n,markdownNotSupportedFallback:void 0}:n;';
  next = next.replace(ANCHOR_STATUSBAR_SESSIONS, `${sbPrefix}${statusBarSnippet}${ANCHOR_STATUSBAR_SESSIONS.slice(sbPrefix.length)}`);
  next = next.replace(ANCHOR_READ_ALLOWED_EXTENSIONS, `${ANCHOR_READ_ALLOWED_EXTENSIONS}${trustedAuthSnippet}`);
  return patchTerminalApproval(next, 'Nk', 'sr', 'Ii');
}

function patchWorkbenchContent(rawContent) {
  const cleanContent = stripPatchMarkers(rawContent);
  const a1 = assertUniqueAnchor(cleanContent, ANCHOR_STATUSBAR_WORKBENCH, 'l9e.updateStatusBarTooltip');
  if (!a1.ok) {
    return a1;
  }
  const a2 = assertUniqueAnchor(cleanContent, ANCHOR_READ_ALLOWED_EXTENSIONS, 'AuthenticationAccessService.readAllowedExtensions');
  if (!a2.ok) {
    return a2;
  }
  const a3 = assertUniqueAnchor(cleanContent, ANCHOR_WORKBENCH_ACCOUNTS_MENU, 'C5.resolveMainMenuActions');
  if (!a3.ok) {
    return a3;
  }

  const statusBarSnippet = buildStatusBarTooltipSnippet('workbench-statusbar');
  const trustedAuthSnippet = buildTrustedAuthAccessSnippet('workbench-trusted-auth');
  const accountsOrderSnippet = buildWorkbenchAccountsOrderSnippet();

  const sbPrefix = 'let r=ds(n)?{markdown:n,markdownNotSupportedFallback:void 0}:n;';
  let next = cleanContent.replace(
    ANCHOR_STATUSBAR_WORKBENCH,
    `${sbPrefix}${statusBarSnippet}${ANCHOR_STATUSBAR_WORKBENCH.slice(sbPrefix.length)}`,
  );
  next = next.replace(ANCHOR_READ_ALLOWED_EXTENSIONS, `${ANCHOR_READ_ALLOWED_EXTENSIONS}${trustedAuthSnippet}`);
  const accountsPrefix = 'if(h.length){r.length&&r.push(new ri);for(let g of h)r.push(g instanceof Xe?t.add(g):g)}';
  next = next.replace(
    ANCHOR_WORKBENCH_ACCOUNTS_MENU,
    `${accountsPrefix}${accountsOrderSnippet}${ANCHOR_WORKBENCH_ACCOUNTS_MENU.slice(accountsPrefix.length)}`,
  );
  return patchTerminalApproval(next, 'rC', 'pr', 'ai');
}

function isValidVsOutDir(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  const sessionsJs = path.join(candidate, 'sessions', 'sessions.desktop.main.js');
  const workbenchJs = path.join(candidate, 'workbench', 'workbench.desktop.main.js');
  return fs.existsSync(sessionsJs) && fs.existsSync(workbenchJs);
}

function resolveFromInstallDir(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return null;
  }
  if (isValidVsOutDir(baseDir)) {
    return baseDir;
  }
  const directVs = path.join(baseDir, 'resources', 'app', 'out', 'vs');
  if (isValidVsOutDir(directVs)) {
    return directVs;
  }

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateVs = path.join(baseDir, entry.name, 'resources', 'app', 'out', 'vs');
    if (isValidVsOutDir(candidateVs)) {
      try {
        const stat = fs.statSync(path.join(candidateVs, 'workbench', 'workbench.desktop.main.js'));
        candidates.push({ dir: candidateVs, mtimeMs: stat.mtimeMs });
      } catch {
        candidates.push({ dir: candidateVs, mtimeMs: 0 });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].dir;
}

function detectVsCodeOutDir(explicitRoot) {
  if (explicitRoot) {
    const resolved = resolveFromInstallDir(path.resolve(explicitRoot));
    return resolved;
  }

  const roots = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  roots.push(path.join(programFiles, 'Microsoft VS Code'));
  roots.push(path.join(localAppData, 'Programs', 'Microsoft VS Code'));
  if (programFilesX86) {
    roots.push(path.join(programFilesX86, 'Microsoft VS Code'));
  }
  roots.push(path.join(programFiles, 'Microsoft VS Code Insiders'));
  roots.push(path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders'));

  for (const root of roots) {
    const resolved = resolveFromInstallDir(root);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function getTargets(vsOutDir) {
  return [
    {
      name: 'sessions.desktop.main.js',
      filePath: path.join(vsOutDir, 'sessions', 'sessions.desktop.main.js'),
      patcher: patchSessionsContent,
      expectedAnchors: [
        ANCHOR_TERMINAL_APPROVAL,
        ANCHOR_SESSIONS_PANEL,
        ANCHOR_RENDER_CONTRIBUTED,
        ANCHOR_STATUSBAR_SESSIONS,
        ANCHOR_READ_ALLOWED_EXTENSIONS,
      ],
    },
    {
      name: 'workbench.desktop.main.js',
      filePath: path.join(vsOutDir, 'workbench', 'workbench.desktop.main.js'),
      patcher: patchWorkbenchContent,
      expectedAnchors: [
        ANCHOR_TERMINAL_APPROVAL,
        ANCHOR_STATUSBAR_WORKBENCH,
        ANCHOR_READ_ALLOWED_EXTENSIONS,
        ANCHOR_WORKBENCH_ACCOUNTS_MENU,
      ],
    },
  ];
}

function runCheck(vsOutDir) {
  let allHealthy = true;
  for (const target of getTargets(vsOutDir)) {
    const raw = fs.readFileSync(target.filePath, 'utf8');
    const markers = countPatchMarkers(raw);
    const clean = stripPatchMarkers(raw);
    const anchorErrors = [];
    for (const anchor of target.expectedAnchors) {
      const res = assertUniqueAnchor(clean, anchor, anchor.slice(0, 48));
      if (!res.ok) {
        anchorErrors.push(res.reason);
      }
    }
    const hasBackup = fs.existsSync(`${target.filePath}.bak`);
    if (anchorErrors.length > 0) {
      allHealthy = false;
      console.warn(
        `[patch-sessions-ui] WARN ${target.name}: patched=${markers > 0} (markers=${markers}, bak=${hasBackup}) - ${anchorErrors.join('; ')}`,
      );
    } else {
      const status = markers > 0 ? `patched (markers=${markers})` : 'unpatched (anchors verified)';
      console.log(`[patch-sessions-ui] OK ${target.name}: ${status}, bak=${hasBackup}`);
    }
  }
  return allHealthy;
}

function writeFileSafely(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'EPERM' || code === 'EACCES') {
      console.error(
        `[patch-sessions-ui] Permission denied writing ${filePath}. Re-run PowerShell as Administrator or pass -SkipUiPatch.`,
      );
      return false;
    }
    throw error;
  }
}

function runApply(vsOutDir) {
  const targets = getTargets(vsOutDir);
  const prepared = [];

  for (const target of targets) {
    const raw = fs.readFileSync(target.filePath, 'utf8');
    const result = target.patcher(raw);
    if (!result.ok) {
      console.warn(`[patch-sessions-ui] WARN ${target.name}: ${result.reason}. Skipping without modifying files.`);
      return false;
    }
    prepared.push({ target, raw, next: result.content });
  }

  for (const item of prepared) {
    const { target, raw, next } = item;
    const bakPath = `${target.filePath}.bak`;
    if (!fs.existsSync(bakPath)) {
      try {
        fs.writeFileSync(bakPath, stripPatchMarkers(raw), 'utf8');
        console.log(`[patch-sessions-ui] Backup created: ${bakPath}`);
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined;
        if (code === 'EPERM' || code === 'EACCES') {
          console.error(
            `[patch-sessions-ui] Permission denied creating backup ${bakPath}. Re-run PowerShell as Administrator or pass -SkipUiPatch.`,
          );
          return false;
        }
        throw error;
      }
    }

    if (raw === next) {
      console.log(`[patch-sessions-ui] Already up to date: ${target.name}`);
      continue;
    }

    if (!writeFileSafely(target.filePath, next)) {
      return false;
    }
    console.log(`[patch-sessions-ui] Patched: ${target.filePath}`);
  }
  return true;
}

function runUnpatch(vsOutDir) {
  for (const target of getTargets(vsOutDir)) {
    const raw = fs.readFileSync(target.filePath, 'utf8');
    const markers = countPatchMarkers(raw);
    const bakPath = `${target.filePath}.bak`;
    const hasBak = fs.existsSync(bakPath);

    if (markers === 0) {
      console.log(`[patch-sessions-ui] Already unpatched: ${target.name}`);
      continue;
    }

    const stripped = stripPatchMarkers(raw);
    if (!writeFileSafely(target.filePath, stripped)) {
      return false;
    }
    console.log(`[patch-sessions-ui] Unpatched (${markers} block(s) removed): ${target.filePath}`);

    if (hasBak) {
      try {
        const bakContent = fs.readFileSync(bakPath, 'utf8');
        if (bakContent === stripped) {
          fs.unlinkSync(bakPath);
          console.log(`[patch-sessions-ui] Removed matching backup: ${bakPath}`);
        }
      } catch {
        // Ignore backup cleanup failure after successful unpatch
      }
    }
  }
  return true;
}

function parseArgs(argv) {
  const options = {
    mode: null,
    vscodeRoot: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      if (options.mode && options.mode !== 'apply') {
        throw new Error('Specify only one of --apply, --check, or --unpatch.');
      }
      options.mode = 'apply';
    } else if (arg === '--check') {
      if (options.mode && options.mode !== 'check') {
        throw new Error('Specify only one of --apply, --check, or --unpatch.');
      }
      options.mode = 'check';
    } else if (arg === '--unpatch') {
      if (options.mode && options.mode !== 'unpatch') {
        throw new Error('Specify only one of --apply, --check, or --unpatch.');
      }
      options.mode = 'unpatch';
    } else if (arg === '--vscode-root') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --vscode-root');
      }
      options.vscodeRoot = next;
      i += 1;
    } else if (arg.startsWith('--vscode-root=')) {
      options.vscodeRoot = arg.slice('--vscode-root='.length);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/patch-sessions-ui.js (--apply | --check | --unpatch) [--vscode-root <path>]',
      '',
      'Options:',
      '  --apply                Create .bak backups and patch VS Code sessions/workbench UI bundles',
      '  --check                Verify VS Code bundles, patch status, and anchors (read-only)',
      '  --unpatch              Remove AGY_HARNESS_PATCH markers and clean matching .bak files',
      '  --vscode-root <path>   Explicit VS Code install, version hash, or out/vs directory',
      '  -h, --help             Show this help message',
    ].join('\n'),
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[patch-sessions-ui] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help || !options.mode) {
    printUsage();
    if (!options.help) {
      process.exitCode = 1;
    }
    return;
  }

  const vsOutDir = detectVsCodeOutDir(options.vscodeRoot);
  if (!vsOutDir) {
    console.warn(
      '[patch-sessions-ui] Could not locate VS Code out/vs directory (sessions.desktop.main.js & workbench.desktop.main.js). Pass --vscode-root <path>.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[patch-sessions-ui] Target VS Code out/vs: ${vsOutDir}`);

  if (options.mode === 'check') {
    const ok = runCheck(vsOutDir);
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.mode === 'apply') {
    const ok = runApply(vsOutDir);
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.mode === 'unpatch') {
    const ok = runUnpatch(vsOutDir);
    if (!ok) {
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PATCH_START,
  PATCH_END,
  detectVsCodeOutDir,
  stripPatchMarkers,
  createTerminalApproval,
  renderQuotaRow,
  renderQuotaGroups,
  patchSessionsContent,
  patchWorkbenchContent,
};
