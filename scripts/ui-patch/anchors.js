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
