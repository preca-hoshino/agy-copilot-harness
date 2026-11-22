const { validateSnippetSyntax } = require('./validate');

function buildExternalEditBaselineSnippet({ item, session, idx, reqId, revive, parts }) {
  const snippet = `if(${item}.start&&${session}?.editingSession&&${idx}!==void 0&&${reqId}&&Array.isArray(${item}.resources)){const _agyRes=${revive}(${item}.resources);if(_agyRes.some(_agyU=>typeof _agyU?.query==="string"&&_agyU.query.includes("__agy_before="))){const _agyClean=[],_agyBefore=[];for(const _agyU of _agyRes){const _agyQ=_agyU.query||"";const _agyM=/(?:^|&)__agy_before=([^&]+)/.exec(_agyQ);const _agyNextQ=_agyQ.split("&").filter(_agyS=>_agyS&&!_agyS.startsWith("__agy_before=")).join("&");_agyClean.push(_agyU.with({query:_agyNextQ}));_agyBefore.push(_agyM?_agyU.constructor.parse(decodeURIComponent(_agyM[1])):void 0);}const _agyEdits=await ${session}.editingSession.startExternalEdits(${reqId},${idx},_agyClean,${item}.undoStopId,_agyBefore);${parts}.push(..._agyEdits);continue;}}`;
  const check = validateSnippetSyntax(
    snippet,
    `async function _w(${item},${session},${idx},${reqId},${parts}){for(const _ of[0]){if(true){`,
    `}}}`,
    'external-edit-baseline',
  );
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildWorkingSetDedupSnippet({ arg1, arg2, arg3 }) {
  const snippet = `const _agyBaseChanges=${arg2};${arg2}={read:(_agyR)=>{const _agyBase=_agyBaseChanges.read(_agyR);const _agyRes=${arg1}?.chatSessionResource||this._widget?.viewModel?.model.sessionResource;if(_agyRes?.scheme!=="antigravity"||!Array.isArray(_agyBase)||_agyBase.length===0)return _agyBase;const _agyLive=${arg3}.read(_agyR);if(!Array.isArray(_agyLive)||_agyLive.length===0)return _agyBase;const _agySeen=new Set(_agyLive.map(_agyX=>_agyX?.reference?.toString?.()).filter(Boolean));return _agyBase.filter(_agyX=>!_agySeen.has(_agyX?.reference?.toString?.()));}};`;
  const check = validateSnippetSyntax(snippet, `function _w(e,${arg1},${arg2},${arg3}){`, `}`, 'working-set-dedup');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildEditingActionNotifySnippet({ action }) {
  const snippet = `;${action}.sessionResource?.scheme==="antigravity"&&this.commandService?.executeCommand("antigravityHarness._onEditingAction",${action}.sessionResource,${action}.action)?.then?.(void 0,()=>{});`;
  const check = validateSnippetSyntax(snippet, `function _w(${action}){if(true){t()`, `}}`, 'editing-action-notify');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildSideChatSessionSnippet({ revive }) {
  const snippet = `,this.sessionResource?.scheme==="antigravity"&&(this.sideChatOrigin={read:()=>globalThis.__agySideChatOrigins?.get(this.sessionResource.toString())},this.createSideChat=async(_agyTurnId,_agyToken,_agySelection,_agyIncludeSource)=>{const _agyRaw=await this._proxy.$forkChatSession(this._providerHandle,this.sessionResource,{type:"request",id:_agyTurnId??"",prompt:JSON.stringify({sideChat:!0,turnId:_agyTurnId,selection:_agySelection,includeSourceContext:_agyIncludeSource!==!1}),participant:"antigravity.agent",command:"btw",variableData:void 0,modelId:void 0,modeInstructions:void 0},_agyToken),_agyItem=${revive}(_agyRaw);return(globalThis.__agySideChatOrigins??=new Map).set(_agyItem.resource.toString(),{sourceSessionResource:this.sessionResource,turnId:_agyTurnId,selection:_agySelection}),_agyItem})`;
  const check = validateSnippetSyntax(snippet, `function _w(){void 0`, `}`, 'side-chat-session');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

module.exports = {
  buildExternalEditBaselineSnippet,
  buildWorkingSetDedupSnippet,
  buildEditingActionNotifySnippet,
  buildSideChatSessionSnippet,
};
