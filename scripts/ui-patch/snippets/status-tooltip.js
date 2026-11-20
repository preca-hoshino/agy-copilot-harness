const { renderQuotaGroups, renderQuotaRow } = require('./quota-rendering');
const { validateSnippetSyntax } = require('./validate');

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
}`.replace(/\r?\n\s*/g, '');

  const check = validateSnippetSyntax(body, '(function(e,n){let r=n;', '})', label);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

module.exports = { buildStatusBarTooltipSnippet };
