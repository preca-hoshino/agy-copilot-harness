// Match the surrounding code, not minifier-generated helper names, and capture the names used by the snippets.
const COMMON_ANCHORS = {
  statusBar: [
    /let r=[$\w]+\(n\)\?\{markdown:n,markdownNotSupportedFallback:void 0\}:n;(?=this\.hover\?this\.hover\.update\(r,i\):this\.hover=this\._register\(this\.hoverService\.setupManagedHover\(this\.hoverDelegate,this\.container,r,i\)\))/g,
    'status bar tooltip',
  ],
  trustedAuth: [
    'readAllowedExtensions(e,t){let i=[];try{let a=this._storageService.get(`${e}-${t}`,-1);a&&(i=JSON.parse(a))}catch{}let n=this._productService.trustedExtensionAuthAccess,r=Array.isArray(n)?n:typeof n=="object"?n[e]??[]:[];',
    'AuthenticationAccessService.readAllowedExtensions',
  ],
  sessionHarnessIcon: [
    /\brenderHarness\((?<session>[$\w]+),(?<template>[$\w]+)\)\{let (?<provider>[$\w]+)=[$\w]+\(\k<session>\.providerType\),(?<icon>[$\w]+)=\k<provider>\?[$\w]+\(\k<provider>\):\k<session>\.icon;(?=\k<template>\.harnessIcon\.className=`agent-session-harness-icon \$\{[$\w]+\.asClassName\(\k<icon>\)\}`)/g,
    'AgentSessionRenderer.renderHarness provider icon',
  ],
  agentSessionIcon: [
    /\btoAgentSession\((?<session>[$\w]+)\)\{(?=return\{\.\.\.\k<session>,children:\k<session>\.children\?\.map\([$\w]+=>this\.toAgentSession\([$\w]+\)\),isArchived:\(\)=>this\.isArchived\(\k<session>\))/g,
    'AgentSessionsModel.toAgentSession provider icon',
  ],
  sessionDelegation: [
    /\bsupportsDelegationForSessionType\((?<type>[$\w]+)\)\{(?=return this\._contributions\.get\(\k<type>\)\?\.contribution\?\.supportsDelegation!==!1\})/g,
    'ChatSessionsService.supportsDelegationForSessionType',
  ],
  terminalApproval: [
    /let\{progress:n,chatSession:r,isSubagent:a\}=i,c=\[\],l=r\?\.getRequests\(\)\.find\(u=>u\.id===e\)\?\.response;for\(let u of t\)\{let\[p,h\]=Array\.isArray\(u\)\?u:\[u\];(?=if\(p\.kind==="externalEdits"\))/g,
    'MainThreadChatAgents2.$handleProgressChunk terminal approval',
  ],
  terminalInvocation: [
    /source:(?<source>[A-Za-z_$][\w$]*)\.External,displayName:e\.toolName,modelDescription:e\.toolName\},r=new (?<invocation>[A-Za-z_$][\w$]*)\(\{invocationMessage:e\.invocationMessage,pastTenseMessage:e\.pastTenseMessage,toolSpecificData:e\.toolSpecificData\}/g,
    'external tool invocation constructor and source',
  ],
  sessionType: [
    /\bfunction (?<sessionType>[A-Za-z_$][\w$]*)\((?<uri>[$\w]+)\)\{return \k<uri>\.scheme===[$\w]+\.vscodeChatEditor\?(?<defaultType>[$\w]+):\k<uri>\.scheme===[$\w]+\.scheme\?\k<uri>\.authority\|\|\k<defaultType>:\k<uri>\.scheme\}/g,
    'chat session URI type helper',
  ],
  terminalAnswer: ['this._proxy.$handleQuestionCarouselAnswer(', 'question carousel answer handler'],
  sessionHistoryUsage: [
    /return\{type:"response",parts:(?<turn>[$\w]+)\.parts\.map\((?<part>[$\w]+)=>(?<revive>[$\w]+)\(\k<part>\)\),participant:\k<turn>\.participant,details:\k<turn>\.details\}\}\)\)(?=,[$\w]+\.hasActiveResponseCallback)/g,
    'ChatSessions._doInitializeContent history usage',
  ],
  externalEditBaseline: [
    /if\((?<item>[A-Za-z_$][\w$]*)\.kind==="externalEdits"\)\{(?=if\((?<session>[A-Za-z_$][\w$]*)\?\.editingSession&&(?<idx>[A-Za-z_$][\w$]*)!==void 0&&(?<reqId>[A-Za-z_$][\w$]*)\)\{let [A-Za-z_$][\w$]*=\k<item>\.start\?await \k<session>\.editingSession\.startExternalEdits\(\k<reqId>,\k<idx>,(?<revive>[A-Za-z_$][\w$]*)\(\k<item>\.resources\),\k<item>\.undoStopId\):await \k<session>\.editingSession\.stopExternalEdits\(\k<reqId>,\k<idx>\);(?<parts>[A-Za-z_$][\w$]*)\.push\()/g,
    'MainThreadChatAgents2.$handleProgressChunk externalEdits baseline',
  ],
  liveEditPill: [
    /if\((?<item>[A-Za-z_$][\w$]*)\.kind==="externalEdits"\)\{if\((?<session>[A-Za-z_$][\w$]*)\?\.editingSession&&(?<idx>[A-Za-z_$][\w$]*)!==void 0&&(?<reqId>[A-Za-z_$][\w$]*)\)\{let [A-Za-z_$][\w$]*=\k<item>\.start\?await \k<session>\.editingSession\.startExternalEdits\(\k<reqId>,\k<idx>,(?<revive>[A-Za-z_$][\w$]*)\(\k<item>\.resources\),\k<item>\.undoStopId\):await \k<session>\.editingSession\.stopExternalEdits\(\k<reqId>,\k<idx>\);(?<parts>[A-Za-z_$][\w$]*)\.push\(\.\.\.[A-Za-z_$][\w$]*\)\}continue\}(?=if\(\k<item>\.kind==="beginToolInvocation"\)\{)/g,
    'MainThreadChatAgents2.$handleProgressChunk live edit pill',
  ],
  workingSetDedup: [
    /\brenderChatEditingSessionWithEntries\((?<arg0>[A-Za-z_$][\w$]*),(?<arg1>[A-Za-z_$][\w$]*),(?<arg2>[A-Za-z_$][\w$]*),(?<arg3>[A-Za-z_$][\w$]*)\)\{/g,
    'renderChatEditingSessionWithEntries deduplication',
  ],
  editingActionNotify: [
    /\bnotifyUserAction\((?<action>[A-Za-z_$][\w$]*)\)\{if\(this\._chatServiceTelemetry\.notifyUserAction\(\k<action>\),this\._onDidPerformUserAction\.fire\(\k<action>\),\k<action>\.action\.kind==="chatEditingSessionAction"\)\{let (?<model>[A-Za-z_$][\w$]*)=this\._sessionModels\.get\(\k<action>\.sessionResource\);\k<model>&&\k<model>\.notifyEditingAction\(\k<action>\.action\)(?=\}\})/g,
    'ChatService.notifyUserAction editing action sync',
  ],
  sideChatSession: [
    /(?<dto>[A-Za-z_$][\w$]*)\.hasForkHandler&&!this\.forkSession&&\(this\.forkSession=async\((?<c>[A-Za-z_$][\w$]*),(?<l>[A-Za-z_$][\w$]*)\)=>\{let (?<u>[A-Za-z_$][\w$]*)=await this\._proxy\.\$forkChatSession\(this\._providerHandle,this\.sessionResource,\k<c>\?this\.toRequestDto\(\k<c>\):void 0,\k<l>\);return (?<revive>[A-Za-z_$][\w$]*)\(\k<u>\)\}\)/g,
    'RemoteSession sideChat and fork bridge',
  ],
  modePermissionsPicker: [
    /\brenderLabel\((?<el>[$\w]+)\)\{let (?<children>[$\w]+)=\[\];\k<el>\.classList\.add\("chat-session-option-picker"\);let (?<group>[$\w]+)=this\.delegate\.getOptionGroup\(\),(?<compact>[$\w]+)=this\._pickerOptions\?\.compact\.get\(\)\?\?!1;\k<el>\.classList\.toggle\("compact",\k<compact>\);(?=let (?<label>[$\w]+)=this\.currentOption\?\.name\?\?\k<group>\?\.description\?\?[$\w]+\(15978,null\),(?<isDefaultIcon>[$\w]+)=this\.currentOption\?\.default&&this\.currentOption\?\.icon;return \k<el>\.classList\.toggle\("icon-only",\k<compact>&&!!this\.currentOption\?\.icon\),this\.currentOption\?\.icon&&\k<children>\.push\((?<renderIcon>[A-Za-z_$][\w$]*)\((?<toIcon>[A-Za-z_$][\w$]*)\(this\.currentOption\.icon\)\)\),!\k<isDefaultIcon>&&\(!\k<compact>\|\|!this\.currentOption\?\.icon\)&&\k<children>\.push\((?<dom>[A-Za-z_$][\w$]*)\("span\.chat-session-option-label",void 0,\k<label>\)\),(?<reset>[A-Za-z_$][\w$]*)\(\k<el>,\.\.\.\k<children>\),this\.setAriaLabelAttributes\(\k<el>\),\k<el>\.ariaLabel=\k<label>,null\})/g,
    'ChatSessionOptionPicker.renderLabel 2-tier mode and permissions picker',
  ],
};

const SESSIONS_ANCHORS = {
  ...COMMON_ANCHORS,
  panel: [
    'if(this.chatEntitlementService.sentiment.hidden||e.add(this.instantiationService.createInstance(',
    'Sessions.createCombinedPanelContent insertion point',
  ],
  panelMethod: ['createCombinedPanelContent(e){', 'Sessions.createCombinedPanelContent method'],
  panelDom: [
    /[,;]l=(?<append>[A-Za-z_$][\w$]*)\(t,(?<element>[A-Za-z_$][\w$]*)\("\.sessions-account-titlebar-panel-identities"\)\);/g,
    'Sessions account panel DOM helpers',
  ],
  panelActions: [
    /=e\.add\(new (?<actionBar>[A-Za-z_$][\w$]*)\([$\w]+\)\);e\.add\((?<bar>[$\w]+)\.onWillRun\(\(\)=>\{this\.hoverService\.hideHover\(!0\),this\.clickPanelDisposable\.clear\(\)\}\)\),\k<bar>\.push\(e\.add\(new (?<action>[A-Za-z_$][\w$]*)\("copilot\.manageModels",/g,
    'Sessions account panel action helpers',
  ],
  chatStatus: [
    /(?:\bvar |,)(?<chatStatusToken>[A-Za-z_$][\w$]*)=[$\w]+\("chatStatusItemService"\)/g,
    'Sessions chat status item service',
  ],
  contributed: ['renderContributedSections(e){for(let t of e){', 'Sessions.renderContributedSections'],
  sessionsModelHelpers: [
    /function (?<getModels>[$\w]+)\((?<lms>[$\w]+)\)\{return \k<lms>\.getLanguageModelIds\(\)\.map\([$\w]+=>\{let [$\w]+=\k<lms>\.lookupLanguageModel\([$\w]+\);return [$\w]+\?\{identifier:[$\w]+,metadata:[$\w]+\}:void 0\}\)\.filter\([$\w]+=>[$\w]+!==void 0\)\}function [$\w]+\([\s\S]{1,400}?function (?<resolveModel>[$\w]+)\([$\w]+,[$\w]+,[$\w]+,[$\w]+\)\{return [$\w]+\([$\w]+,[$\w]+,\{hasLiveModels:/g,
    'Sessions language model snapshot helpers',
  ],
  sessionsOptionPicker: [
    /\bvar (?<mutCls>[$\w]+)=class extends [$\w]+\{constructor\([$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+\)\{let\{group:[$\w]+,item:[$\w]+\}=[$\w]+,[\s\S]{1,350}?getActions:\(\)=>this\.getDropdownActions\(\)/g,
    'Sessions ChatSessionOptionPicker class',
  ],
  sessionsChatInputPicker: [
    /id:(?<chatInput>[$\w]+)\.ChatInput,order:4,group:"navigation",when:(?<expr>[$\w]+)\.and\((?<ctx>[$\w]+)\.chatSessionHasModels,\k<ctx>\.chatSessionType\.isEqualTo\((?<providerEnum>[$\w]+)\.Cloud\),\k<ctx>\.lockedToCodingAgent\)\},(?=\{id:\k<chatInput>\.ChatInputSecondary,order:4,group:"navigation",when:\k<expr>\.and\(\k<ctx>\.chatSessionHasModels,\k<ctx>\.chatSessionType\.notEqualsTo\(\k<providerEnum>\.Cloud\),\k<expr>\.or\((?<isSess>[$\w]+)\.negate\(\),)/g,
    'Sessions opened chat primary option picker menu',
  ],
  sessionsNewModeViewItem: [
    /(?<expr>[$\w]+)\.and\((?<sessionsWin>[$\w]+),(?<ctx>[$\w]+)\.enabled,[$\w]+\.or\([$\w]+,(?<tiKey>[$\w]+)\.isEqualTo\((?<sandboxProv>[$\w]+)\)\)\),G4e=class extends [$\w]+\{static\{this\.ID="workbench\.contrib\.copilotPickerActionViewItems"\}constructor\((?<reg>[$\w]+),(?<layout>[$\w]+)\)\{super\(\),this\._register\(\k<reg>\.register\((?<menuId>[$\w]+\.NewSessionControl),"sessions\.sandbox\.modePicker",\([$\w]+,[$\w]+,[$\w]+\)=>\{let [$\w]+=[$\w]+\.invokeFunction\([$\w]+=>[$\w]+\.get\((?<mgmtSvc>[$\w]+)\)\);return new [$\w]+\([\s\S]{1,120}?\)\}\)\)/g,
    'Sessions NewSessionControl mode picker view item registry',
  ],
  sessionsNewModeAction: [
    /function dis\(\)\{let (?<disp>[$\w]+)=new [$\w]+;for\(let\[[$\w]+,[$\w]+,[$\w]+\]of\[\["sessions\.sandbox\.modePicker"[\s\S]{1,220}?\k<disp>\.add\((?<regAct>[$\w]+)\(class extends (?<actCls>[$\w]+)\{[\s\S]{1,180}?\}\)\);(?=return \k<disp>\})/g,
    'Sessions NewSessionControl mode picker menu action registration',
  ],
  sessionsDraftFactory: [
    /_createDraftSession\([$\w]+,[$\w]+,[$\w]+\)\{if\(this\._assertCloudSessionsEnabled\(\)[\s\S]{1,1200}?[,;](?<uriVar>[$\w]+)=(?<uriCls>[$\w]+)\.from\(\{scheme:[$\w]+,path:`\/untitled-\$\{(?<uuidFn>[$\w]+)\(\)\}`\}\),(?<varName>[$\w]+)=this\.(?<inst>[$\w]+)\.createInstance\((?<draftCls>[$\w]+),/g,
    'Sessions draft session class and URI factory',
  ],
  sessionsCacheItem: [
    /_refreshSessionCache\(\)\{if\(this\.providerMode==="sandbox"\)return;[\s\S]{1,600}?let (?<item>[$\w]+)=new (?<itemCls>[$\w]+)\((?<agent>[$\w]+),this\.id,this\.gitHubService,this\.pullRequestIconCache,this\.logService\);/g,
    'Sessions cached session item wrapper',
  ],
  sessionsDefaultProvider: [
    /function Nos\((?<services>[$\w]+)\)\{let (?<inst>[$\w]+)=\k<services>\.get\([$\w]+\),(?<regSvc>[$\w]+)=\k<services>\.get\([$\w]+\),[^;]+,(?<disp>[$\w]+)=new [$\w]+,(?<prov>[$\w]+)=\k<disp>\.add\(\k<inst>\.createInstance\((?<xfeCls>[$\w]+),"default"\)\);(?=if\(\k<disp>\.add\(\k<regSvc>\.registerProvider\(\k<prov>\)\),)/g,
    'Sessions default provider registration',
  ],
};

const WORKBENCH_ANCHORS = {
  ...COMMON_ANCHORS,
  accounts: [
    /if\(h\.length\)\{r\.length&&r\.push\(new (?<separator>[A-Za-z_$][\w$]*)\);for\(let g of h\)r\.push\(g instanceof [$\w]+\?t\.add\(g\):g\)\}(?=return p\(u\),r\})/g,
    'Workbench.resolveMainMenuActions',
  ],
};

function resolveAnchors(content, anchors) {
  const matches = {};
  const errors = [];
  for (const [name, [pattern, label]] of Object.entries(anchors)) {
    let match;
    let duplicate;
    if (typeof pattern === 'string') {
      const index = content.indexOf(pattern);
      if (index !== -1) {
        match = { start: index, end: index + pattern.length };
        duplicate = content.indexOf(pattern, index + 1) !== -1;
      }
    } else {
      const [first, second] = content.matchAll(pattern);
      if (first) {
        match = { start: first.index, end: first.index + first[0].length, groups: first.groups };
        duplicate = second !== undefined;
      }
    }
    if (!match) {
      errors.push(`Anchor not found: ${label}`);
    } else if (duplicate) {
      errors.push(`Anchor matched more than once: ${label}`);
    } else {
      matches[name] = match;
    }
  }
  return errors.length ? { ok: false, reason: errors.join('; ') } : { ok: true, matches };
}

module.exports = { SESSIONS_ANCHORS, WORKBENCH_ANCHORS, resolveAnchors };
