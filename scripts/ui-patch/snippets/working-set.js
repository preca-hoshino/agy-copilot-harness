const { validateSnippetSyntax } = require('./validate');

function buildExternalEditBaselineSnippet({ item, session, idx, reqId, revive, parts }) {
  const snippet = `if(${session}?.sessionResource?.scheme==="antigravity"&&${session}?.editingSession&&${idx}!==void 0&&${reqId}){if(${item}.start&&Array.isArray(${item}.resources)){const _agyRes=${revive}(${item}.resources);const _agyClean=[],_agyBefore=[];for(const _agyU of _agyRes){const _agyQ=_agyU?.query||"";const _agyM=/(?:^|&)__agy_before=([^&]+)/.exec(_agyQ);const _agyNextQ=_agyQ.split("&").filter(_agyS=>_agyS&&!_agyS.startsWith("__agy_before=")).join("&");_agyClean.push(typeof _agyU?.with==="function"?_agyU.with({query:_agyNextQ}):_agyU);_agyBefore.push(_agyM&&typeof _agyU?.constructor?.parse==="function"?_agyU.constructor.parse(decodeURIComponent(_agyM[1])):void 0);}await ${session}.editingSession.startExternalEdits(${reqId},${idx},_agyClean,${item}.undoStopId,_agyBefore);const _agyRespParts=typeof ${reqId}==="object"?(${reqId}?._response?._responseParts??${reqId}?.response?.value??${reqId}?._responseParts):void 0;for(let _agyI=0;_agyI<_agyClean.length;_agyI++){const _agyCleanUri=_agyClean[_agyI];const _agyEntryOrig=${session}.editingSession.getEntry?.(_agyCleanUri)?.originalURI;const _agyResolvedBefore=_agyEntryOrig??(typeof ${session}.editingSession.getEntry==="function"?void 0:_agyBefore[_agyI]);if(!_agyResolvedBefore)continue;const _agyCleanKey=_agyCleanUri?.toString?.();if(_agyCleanKey&&typeof ${reqId}==="object"){${reqId}.__agyBeforeUris??=new Map();${reqId}.__agyBeforeUris.set(_agyCleanKey,_agyResolvedBefore);for(const _agyArr of [_agyRespParts,${parts}]){if(!Array.isArray(_agyArr))continue;for(const _agyPart of _agyArr){if(_agyPart?.kind==="externalEdit"&&_agyPart.uri?.toString?.()===_agyCleanKey){if(!_agyPart.beforeContentUri)_agyPart.beforeContentUri=_agyResolvedBefore;if(!_agyPart.afterContentUri)_agyPart.afterContentUri=_agyCleanUri;}}}}}continue;}else if(!${item}.start){await ${session}.editingSession.stopExternalEdits(${reqId},${idx});continue;}}`;
  const check = validateSnippetSyntax(
    snippet,
    `async function _w(${item},${session},${idx},${reqId},${parts},${revive}){for(const _ of[0]){if(true){`,
    `}}}`,
    'external-edit-baseline',
  );
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildLiveEditPillSnippet({ item, session, reqId, parts }) {
  const snippet = `if(${item}.kind==="externalToolInvocationUpdate"&&${session}?.sessionResource?.scheme==="antigravity"&&typeof ${item}.toolSpecificData?.uri==="string"&&${item}.toolSpecificData.agyEdit!==!1&&${item}.isComplete&&!${item}.errorMessage&&!${item}.resultDetails?.isError){const _agyParse=${session}.sessionResource?.constructor?.parse;if(typeof _agyParse==="function"){const _agyEntries=Array.isArray(${item}.toolSpecificData.changes)&&${item}.toolSpecificData.changes.length>0?${item}.toolSpecificData.changes:[${item}.toolSpecificData];const _agyEdits=[];const _agyBeforeMap=typeof ${reqId}==="object"?${reqId}?.__agyBeforeUris:void 0;const _agyRespParts=typeof ${reqId}==="object"?(${reqId}?._response?._responseParts??${reqId}?.response?.value??${reqId}?._responseParts):void 0;const _agyHasPill=(_agyU)=>{const _agyKey=_agyU.toString();for(const _agyArr of [_agyRespParts,${parts}]){if(!Array.isArray(_agyArr))continue;if(_agyArr.some(_agyP=>_agyP?.kind==="externalEdit"&&_agyP.undoStopId===${item}.toolCallId&&_agyP.uri?.toString?.()===_agyKey))return!0;}return!1;};for(const _agyEntry of _agyEntries){if(typeof _agyEntry?.uri!=="string")continue;let _agyUri;try{_agyUri=_agyParse(_agyEntry.uri);}catch{continue;}if(_agyHasPill(_agyUri))continue;const _agyBeforeUri=_agyBeforeMap?.get?.(_agyUri.toString());_agyEdits.push({kind:"externalEdit",uri:_agyUri,editKind:_agyEntry.editKind==="create"?"create":"edit",diff:{added:typeof _agyEntry.insertions==="number"?_agyEntry.insertions:0,removed:typeof _agyEntry.deletions==="number"?_agyEntry.deletions:0},...(_agyBeforeUri?{beforeContentUri:_agyBeforeUri}:{}),afterContentUri:_agyUri,undoStopId:${item}.toolCallId,...(${item}.subagentInvocationId!==void 0?{subAgentInvocationId:${item}.subagentInvocationId}:{})});}for(let _agyI=${parts}.length-1;_agyI>=0;_agyI--){if(${parts}[_agyI]?.kind==="externalToolInvocationUpdate"&&${parts}[_agyI]?.toolCallId===${item}.toolCallId)${parts}.splice(_agyI,1);}const _agyExisting=Array.isArray(_agyRespParts)?_agyRespParts.findLast(_agyP=>_agyP?.kind==="toolInvocation"&&_agyP.toolCallId===${item}.toolCallId):void 0;if(_agyExisting){_agyExisting.presentation="hidden";const _agyStateType=_agyExisting.state?.get?.()?.type;if(_agyStateType===4||_agyStateType===5){const _agyIdx=_agyRespParts.lastIndexOf(_agyExisting);if(_agyIdx!==-1)_agyRespParts.splice(_agyIdx,1);}else{${parts}.push(${item});}}if(_agyEdits.length>0)${parts}.push(..._agyEdits);continue;}}`;
  const check = validateSnippetSyntax(
    snippet,
    `async function _w(${item},${session},${reqId},${parts}){for(const _ of[0]){`,
    `}}`,
    'live-edit-pill',
  );
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildWorkingSetDedupSnippet({ arg1, arg2, arg3 }) {
  const snippet =
    `const _agyBaseChanges=${arg3};${arg3}={read:(_agyR)=>{` +
    `const _agyBase=_agyBaseChanges.read(_agyR);` +
    `const _agyRes=${arg1}?.chatSessionResource||this._widget?.viewModel?.model.sessionResource;` +
    `if(_agyRes?.scheme!=="antigravity"||!Array.isArray(_agyBase)||_agyBase.length===0)return _agyBase;` +
    `const _agyLive=${arg2}.read(_agyR);` +
    `const _agyEntries=${arg1}?.entries?.read?.(_agyR);` +
    `if((!Array.isArray(_agyLive)||_agyLive.length===0)&&(!Array.isArray(_agyEntries)||_agyEntries.length===0))return _agyBase;` +
    `const _agySeen=new Set();` +
    `if(Array.isArray(_agyLive))for(const _agyX of _agyLive){const _agyU=_agyX?.reference?.toString?.();if(_agyU)_agySeen.add(_agyU);}` +
    `if(Array.isArray(_agyEntries))for(const _agyE of _agyEntries){const _agyM=_agyE?.modifiedURI?.toString?.();if(_agyM)_agySeen.add(_agyM);const _agyO=_agyE?.originalURI?.toString?.();if(_agyO&&_agyE?.isDeletion)_agySeen.add(_agyO);}` +
    `if(_agySeen.size===0)return _agyBase;` +
    `return _agyBase.filter(_agyX=>!_agySeen.has(_agyX?.reference?.toString?.()));` +
    `}};`;
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

function buildSubagentReadOnlySnippet({ constObs }) {
  const snippet = `,((t?.resource??this._sessionResource)?.scheme==="antigravity"&&((t?.resource??this._sessionResource)?.path?.startsWith("/subagent/")||(t?.resource??this._sessionResource)?.query?.includes("subagentChatResource="))&&(this.isReadOnly=${constObs}(!0)))`;
  const check = validateSnippetSyntax(
    snippet,
    `function _w(t,${constObs}){this._canUseTools=t.canUseTools,this.isReadOnly=t.isReadOnly??${constObs}(!1)`,
    `,this.isInputBlocked=t.isInputBlocked}`,
    'subagent-read-only',
  );
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildSubagentSessionInputSnippet({ sess }) {
  const snippet = `,...(${sess}?.scheme==="antigravity"&&(${sess}.path?.startsWith("/subagent/")||${sess}.query?.includes("subagentChatResource="))?{inputState:void 0}:{})`;
  const check = validateSnippetSyntax(snippet, `function _w(${sess}){return{sessionResource:${sess}`, `}}`, 'subagent-session-input');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

function buildEditorEditingSessionSnippet({ loc, model, transfer }) {
  const snippet = `,(${loc}!=="panel"&&${model}.sessionResource?.scheme==="antigravity"&&!(${model}.sessionResource.path?.startsWith("/subagent/")||${model}.sessionResource.query?.includes("subagentChatResource="))&&${model}.startEditingSession(!1,${transfer}))`;
  const check = validateSnippetSyntax(
    snippet,
    `function _w(${loc},${model},${transfer}){return ${loc}==="panel"&&${model}.startEditingSession(!0,${transfer})`,
    `,${model}}`,
    'editor-editing-session',
  );
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return snippet;
}

module.exports = {
  buildEditingActionNotifySnippet,
  buildEditorEditingSessionSnippet,
  buildExternalEditBaselineSnippet,
  buildLiveEditPillSnippet,
  buildSideChatSessionSnippet,
  buildSubagentReadOnlySnippet,
  buildSubagentSessionInputSnippet,
  buildWorkingSetDedupSnippet,
};
