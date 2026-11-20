const { validateSnippetSyntax } = require('./validate');

function buildTrustedAuthAccessSnippet(label) {
  const body =
    'if(e==="google-antigravity"&&!r.includes("antigravity.agy-copilot-harness"))r=[...r,"antigravity.agy-copilot-harness"];';
  const check = validateSnippetSyntax(body, '(function(e){let r=[];', '})', label);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

function buildWorkbenchAccountsOrderSnippet({ separator }) {
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
    while(_agyRest.length>0&&_agyRest[0]instanceof ${separator})_agyRest.shift();
    const _agyCleaned=[];
    for(const _act of _agyRest){
      if(_act instanceof ${separator}&&(_agyCleaned.length===0||_agyCleaned[_agyCleaned.length-1]instanceof ${separator}))continue;
      _agyCleaned.push(_act);
    }
    if(h.length===0&&_agyCleaned.length>0&&!(_agyCleaned[_agyCleaned.length-1]instanceof ${separator}))_agyCleaned.push(new ${separator});
    _agyCleaned.push(..._agyMoved);
    r=_agyCleaned;
  }
}
}catch{}`.replace(/\r?\n\s*/g, '');

  const check = validateSnippetSyntax(body, '(function(r,h){', 'return r;})', 'workbench-accounts-order');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

module.exports = { buildTrustedAuthAccessSnippet, buildWorkbenchAccountsOrderSnippet };
