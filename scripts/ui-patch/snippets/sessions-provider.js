function buildSessionsProviderSnippet(
  { services, inst, regSvc, disp, prov, xfeCls },
  { uriCls, uuidFn, draftCls, inst: draftInst },
  { itemCls },
  { getModels, resolveModel },
) {
  return (
    `;class AntigravityCacheSession extends ${itemCls}{` +
    'constructor(session,providerId,gitHubService,pullRequestIconCache,logService){' +
    'super(session,providerId,gitHubService,pullRequestIconCache,logService);' +
    'this.icon={id:"antigravity-logo"};' +
    '}' +
    '_buildWorkspace(session){' +
    'const base=super._buildWorkspace(session);' +
    'const rawDir=session?.metadata?.workingDirectoryPath??session?.metadata?.cwd;' +
    'if(typeof rawDir!=="string"||!rawDir.trim()){' +
    'if(session?.description==="No Project"&&base)return{...base,label:"No Project"};' +
    'return base;' +
    '}' +
    'const trimmed=rawDir.trim();' +
    'const normalizedSlashes=trimmed.replace(/\\\\/g,"/").replace(/\\/+$/,"")||trimmed;' +
    'const parts=normalizedSlashes.split("/").filter(Boolean);' +
    'const folderName=parts[parts.length-1]||trimmed;' +
    'const uriCtor=session?.resource?.constructor?.file' +
    '?session.resource.constructor' +
    ':base?.folders?.[0]?.root?.constructor?.file' +
    '?base.folders[0].root.constructor' +
    `:${uriCls};` +
    'const folderUri=uriCtor?.file' +
    '?uriCtor.file(trimmed)' +
    `:${uriCls}.from({scheme:"file",path:normalizedSlashes.startsWith("/")?normalizedSlashes:"/"+normalizedSlashes});` +
    'const firstFolder=base?.folders?.[0];' +
    'const folder=firstFolder' +
    '?{...firstFolder,root:folderUri,workingDirectory:folderUri,name:folderName}' +
    ':{root:folderUri,workingDirectory:folderUri,name:folderName,description:void 0,gitRepository:void 0};' +
    'return{...base,uri:folderUri,label:folderName,folders:[folder],requiresWorkspaceTrust:!1,isVirtualWorkspace:!1};' +
    '}' +
    'update(session){const changed=super.update(session);this.icon={id:"antigravity-logo"};return changed;}' +
    '}' +
    `class AntigravitySessionsProvider extends ${xfeCls}{` +
    'constructor(...args){super(...args);this._initAntigravity();}' +
    '_initAntigravity(){' +
    'this.environment={id:"local",label:"Local"};' +
    'this._agyInFlightSends=new Set;' +
    'this._agyLastModeId=void 0;' +
    'this._agyLastInteractiveModeId=void 0;' +
    'this._agyInputStatePromise=void 0;' +
    'this._agyActivationPromise=void 0;' +
    'const EmitterCtor=this._onDidChangeSessionTypes?.constructor;' +
    'this._agyOnDidChangeOptionState=EmitterCtor?this._register(new EmitterCtor):void 0;' +
    'globalThis[Symbol.for("antigravity.sessionsProvider")]=this;' +
    'this._register(this.languageModelsService?.onDidChangeLanguageModels?.(()=>{' +
    'this._onDidChangeSessionTypes?.fire?.();' +
    '})??{dispose(){}});' +
    'this._register(this.chatSessionsService?.onDidChangeItemsProviders?.(e=>{' +
    'if(!e||e.chatSessionType==="antigravity"){' +
    'void this.ensureInputStateLoaded();' +
    'this._onDidChangeSessionTypes?.fire?.();' +
    '}' +
    '})??{dispose(){}});' +
    'this._register(this.chatSessionsService?.onDidChangeOptionGroups?.(t=>{' +
    'if(!t||t==="antigravity")this._fireOptionStateChanged();' +
    '})??{dispose(){}});' +
    'this._refreshSessionCache();' +
    'void this._activateAntigravity();' +
    '}' +
    'get onDidChangeOptionState(){return this._agyOnDidChangeOptionState?.event;}' +
    '_fireOptionStateChanged(){this._agyOnDidChangeOptionState?.fire?.();}' +
    'get id(){return"antigravity";}' +
    'get label(){return"Antigravity";}' +
    'get icon(){return{id:"antigravity-logo"};}' +
    'get sessionTypes(){return[{id:"antigravity",label:"Antigravity",icon:{id:"antigravity-logo"},description:"Google Antigravity ACP agent"}];}' +
    'getHarnessPresentation(harness){return harness==="antigravity"?{label:"Antigravity",icon:{id:"antigravity-logo"}}:void 0;}' +
    'get _cloudSessionsEnabled(){return!0;}' +
    '_assertCloudSessionsEnabled(){}' +
    'get supportsLocalWorkspaces(){return!0;}' +
    'get supportsQuickChats(){return!0;}' +
    'get supportsAutomationSessionConfiguration(){return!1;}' +
    'get browseActions(){return[];}' +
    'getSessionTypes(uri){return!uri||uri.scheme==="file"?this.sessionTypes:[];}' +
    'resolveWorkspace(uri,options){' +
    'if(!uri||uri.scheme!=="file")return void 0;' +
    'const ws=super.resolveWorkspace(uri,options);' +
    'return ws?{...ws,requiresWorkspaceTrust:!1}:void 0;' +
    '}' +
    'async _activateAntigravity(){' +
    'if(this._agyActivationPromise)return this._agyActivationPromise;' +
    'this._agyActivationPromise=(async()=>{' +
    'try{await this.chatSessionsService?.activateChatSessionItemProvider?.("antigravity");}catch{}' +
    'try{await this.languageModelsService?.selectLanguageModels?.({vendor:"antigravity"});}catch{}' +
    'try{await this.ensureInputStateLoaded();}catch{}' +
    'this._refreshSessionCache();' +
    'this._onDidChangeSessionTypes?.fire?.();' +
    'this._fireOptionStateChanged();' +
    '})().finally(()=>{this._agyActivationPromise=void 0;});' +
    'return this._agyActivationPromise;' +
    '}' +
    'async ensureInputStateLoaded(resource){' +
    'if(this._agyInputStatePromise)return this._agyInputStatePromise;' +
    'if(!this.chatSessionsService?.getNewChatSessionInputState)return void 0;' +
    'this._agyInputStatePromise=(async()=>{' +
    'try{return await this.chatSessionsService.getNewChatSessionInputState("antigravity",resource);}catch{return void 0;}' +
    '})().finally(()=>{this._agyInputStatePromise=void 0;this._fireOptionStateChanged();});' +
    'return this._agyInputStatePromise;' +
    '}' +
    'getModelsSnapshot(sessionId,desiredModelId){return this._buildAgyModelsSnapshot(desiredModelId);}' +
    'getModelsSnapshotForCreation(_sessionId,_sessionTypeId,desiredModelId){return this._buildAgyModelsSnapshot(desiredModelId);}' +
    '_buildAgyModelsSnapshot(desiredModelId){' +
    `const allModels=${getModels}(this.languageModelsService);` +
    'const models=allModels.filter(m=>m.metadata?.targetChatSessionType==="antigravity");' +
    'if(models.length===0&&!this._agyActivationPromise)void this._activateAntigravity();' +
    `return{models,desiredModelResolution:${resolveModel}(models,desiredModelId,this.languageModelsService,allModels),modelTarget:"antigravity"};` +
    '}' +
    'getModeOptionGroup(session){' +
    'const groups=this.chatSessionsService?.getOptionGroupsForSessionType?.("antigravity");' +
    'const base=groups?.find(g=>g.id==="mode");' +
    'if(!base){' +
    'void this.ensureInputStateLoaded(session?.resource);' +
    'return{id:"mode",name:"Agent Mode",items:[],selected:void 0};' +
    '}' +
    'const draft=session?.sessionId?this._newSessions.get(session.sessionId):void 0;' +
    'const storedOpt=draft?.selectedOptions?.get("mode")??(session?.resource?this.chatSessionsService?.getSessionOption?.(session.resource,"mode"):void 0);' +
    'const storedId=typeof storedOpt==="string"?storedOpt:storedOpt?.id;' +
    'const selectedId=storedId||this._agyLastModeId||base.selected?.id;' +
    'const interactiveFallback=this._agyLastInteractiveModeId||(base.selected?.agyPickerMeta?.lastInteractiveMode);' +
    'const activeInteractive=selectedId&&selectedId!=="plan"?selectedId:interactiveFallback;' +
    'const items=base.items.map(item=>item.agyPickerMeta&&activeInteractive' +
    '?{...item,agyPickerMeta:{...item.agyPickerMeta,lastInteractiveMode:activeInteractive}}' +
    ':item);' +
    'const selected=items.find(item=>item.id===selectedId)??items.find(item=>item.id===base.selected?.id)??items[0];' +
    'return{...base,items,selected};' +
    '}' +
    'setNewSessionModeOption(session,option){' +
    'const id=typeof option==="string"?option:option?.id;' +
    'if(!id)return;' +
    'this._agyLastModeId=id;' +
    'if(id!=="plan")this._agyLastInteractiveModeId=id;' +
    'const group=this.getModeOptionGroup(session);' +
    'const matched=group.items.find(item=>item.id===id)??option;' +
    'const draft=session?.sessionId?this._newSessions.get(session.sessionId):void 0;' +
    'draft?.setOption?.("mode",matched);' +
    'if(session?.resource)this.chatSessionsService?.setSessionOption?.(session.resource,"mode",matched);' +
    'this._fireOptionStateChanged();' +
    '}' +
    '_refreshSessionCache(){' +
    'const seen=new Set,added=[],changed=[],markUnread=[];' +
    'const hasInFlight=(this._agyInFlightSends?.size??0)>0;' +
    'for(const a of this.agentSessionsService?.model?.sessions??[]){' +
    'if(a.providerType!=="antigravity")continue;' +
    'if(hasInFlight&&a.resource?.path?.startsWith("/untitled-"))continue;' +
    'const key=a.resource.toString();' +
    'seen.add(key);' +
    'const existing=this._sessionCache.get(key);' +
    'if(existing){' +
    'const prevStatus=existing.status.get();' +
    'if(existing.update(a))changed.push(existing);' +
    'const nextStatus=existing.status.get();' +
    'if(prevStatus===1&&nextStatus!==1&&nextStatus!==0&&existing.isRead?.get?.())markUnread.push(a);' +
    '}else{' +
    'const created=new AntigravityCacheSession(a,this.id,this.gitHubService,this.pullRequestIconCache,this.logService);' +
    'this._sessionCache.set(key,created);' +
    'added.push(created);' +
    '}' +
    '}' +
    'const removed=[];' +
    'for(const[key,cached]of this._sessionCache){' +
    'if(!seen.has(key)&&cached instanceof AntigravityCacheSession&&!this._inFlightCommits?.has(key))removed.push(cached);' +
    '}' +
    'for(const item of removed)this._sessionCache.delete(item.resource.toString());' +
    'if(added.length>0||removed.length>0||changed.length>0){' +
    'this._onDidChangeSessions.fire({' +
    'added:added.map(s=>this._chatToSession(s)),' +
    'removed:removed.map(s=>{const w=this._chatToSession(s);this._sessionWrapperCache.delete(s.sessionId);return w;}),' +
    'changed:changed.map(s=>this._chatToSession(s)),' +
    '});' +
    '}' +
    'for(const s of markUnread)s.setRead?.(!1);' +
    '}' +
    '_chatToSession(chatSession){' +
    'const wrapped=super._chatToSession(chatSession);' +
    'if(wrapped.harness!=="antigravity"){' +
    'wrapped.harness="antigravity";' +
    'wrapped.icon={id:"antigravity-logo"};' +
    '}' +
    'return wrapped;' +
    '}' +
    '_createDraftSession(workspaceUri,sessionTypeId,options){' +
    'if(sessionTypeId&&sessionTypeId!=="antigravity")throw new Error(`Unsupported session type \x27${sessionTypeId}\x27`);' +
    'const resolvedWs=workspaceUri?this.resolveWorkspace(workspaceUri):void 0;' +
    'if(workspaceUri&&!resolvedWs)throw new Error(`Cannot resolve workspace for URI: ${workspaceUri.toString()}`);' +
    `const resource=${uriCls}.from({scheme:"antigravity",path:\`/untitled-\${${uuidFn}()}\`});` +
    `const draft=this.${draftInst}.createInstance(${draftCls},resource,resolvedWs,"antigravity",this.id,void 0,!1);` +
    'draft.icon={id:"antigravity-logo"};' +
    'draft.setCreatedBySession?.(options?.createdBySession);' +
    'this._newSessions.set(draft.sessionId,draft);' +
    'const folderRoot=resolvedWs?.folders?.[0]?.root;' +
    'if(folderRoot?.scheme==="file"){' +
    'const folderPath=folderRoot.fsPath||folderRoot.path;' +
    'if(folderPath)draft.setOption("folder",folderPath);' +
    '}' +
    'const modeGroup=this.getModeOptionGroup({resource,sessionId:draft.sessionId});' +
    'if(modeGroup.selected)draft.setOption("mode",modeGroup.selected);' +
    'else void this.ensureInputStateLoaded(resource);' +
    'return this._chatToSession(draft);' +
    '}' +
    'async _sendFirstChat(draft,chatResource,sendOptions){' +
    'const{query,attachedContext}=sendOptions;' +
    'const fallbackTitle=(sendOptions.title||query.split(/\\r?\\n/)[0]).trim().substring(0,100)||"New Antigravity Session";' +
    'draft.setTitle(fallbackTitle);' +
    'draft.setStatus(1);' +
    'this._agyInFlightSends.add(draft.sessionId);' +
    'this._sessionCache.set(draft.resource.toString(),draft);' +
    'const draftSession=this._chatToSession(draft);' +
    'this._onDidChangeSessions.fire({added:[draftSession],removed:[],changed:[]});' +
    'const folderRoot=draft.sessionWorkspace?.folders?.[0]?.root;' +
    'if(folderRoot?.scheme==="file"&&!draft.selectedOptions.has("folder")){' +
    'const folderPath=folderRoot.fsPath||folderRoot.path;' +
    'if(folderPath)draft.setOption("folder",folderPath);' +
    '}' +
    'if(!draft.selectedOptions.has("mode")&&this._agyLastModeId){' +
    'const g=this.getModeOptionGroup(draft);' +
    'const opt=g.items.find(i=>i.id===this._agyLastModeId);' +
    'if(opt)draft.setOption("mode",opt);' +
    '}' +
    'const contrib=this.chatSessionsService?.getChatSessionContribution?.(draft.target);' +
    'const reqOpts={' +
    'location:"panel",' +
    'userSelectedModelId:draft.selectedModelId,' +
    'userSelectedModelConfiguration:draft.modelConfiguration?.getModelConfigurationForRequest?.(draft.selectedModelId),' +
    'agentIdSilent:contrib?.type??"antigravity",' +
    'attachedContext,' +
    'hideFromTranscript:sendOptions.hideFromTranscript,' +
    'onDidCreateResponse:sendOptions.onDidCreateResponse' +
    '};' +
    'const beforeKeys=new Set(' +
    '(this.agentSessionsService?.model?.sessions??[])' +
    '.filter(s=>s.providerType==="antigravity")' +
    '.map(s=>s.resource.toString())' +
    ');' +
    'let stateDisp;' +
    'try{' +
    'stateDisp=await this._updateChatSessionState(chatResource,draft,void 0);' +
    'const sendRes=await this.chatService.sendRequest(chatResource,query,reqOpts);' +
    'if(sendRes.kind==="rejected"){' +
    'this._cleanupRejectedAntigravityDraft(draft,draftSession);' +
    'throw new Error(`[AntigravitySessionsProvider] sendRequest rejected: ${sendRes.reason}`);' +
    '}' +
    'const createdP=sendRes.kind==="sent"?sendRes.data.responseCreatedPromise:void 0;' +
    'const completeP=sendRes.kind==="sent"?sendRes.data.responseCompletePromise:void 0;' +
    'const resolvedUri=await this._waitForRealizedAntigravitySession(beforeKeys,createdP,completeP);' +
    'this._agyInFlightSends.delete(draft.sessionId);' +
    'this._inFlightCommits?.add(resolvedUri.toString());' +
    'try{' +
    'const creator=draft.createdBySession?.get?.();' +
    'if(creator)this._setCreatedBySession?.(resolvedUri,creator);' +
    'this._refreshSessionCache();' +
    'const cached=this._sessionCache.get(resolvedUri.toString())??await this._waitForSessionInCache(resolvedUri,void 0);' +
    'this._sessionCache.delete(draft.resource.toString());' +
    'this._newSessions.deleteAndLeak?.(draft.sessionId);' +
    'this._clearCurrentNewSessionIfMatch(draft);' +
    'const realizedSession=this._chatToSession(cached);' +
    'this._sessionWrapperCache.delete(draft.sessionId);' +
    'this._replaceSession({from:draftSession,to:realizedSession});' +
    'return realizedSession;' +
    '}finally{' +
    'this._inFlightCommits?.delete(resolvedUri.toString());' +
    '}' +
    '}catch(err){' +
    'this._agyInFlightSends.delete(draft.sessionId);' +
    'if(err?.name==="Canceled"){' +
    'this._clearCurrentNewSessionIfMatch(draft,!0);' +
    'draft.setStatus(3);' +
    'this._onDidChangeSessions.fire({added:[],removed:[],changed:[draftSession]});' +
    'return draftSession;' +
    '}' +
    'this._cleanupRejectedAntigravityDraft(draft,draftSession);' +
    'throw err;' +
    '}finally{' +
    'this._agyInFlightSends.delete(draft.sessionId);' +
    'stateDisp?.dispose?.();' +
    '}' +
    '}' +
    '_cleanupRejectedAntigravityDraft(draft,draftSession){' +
    'this._sessionCache.delete(draft.resource.toString());' +
    'this._sessionWrapperCache.delete(draft.sessionId);' +
    'this._newSessions.deleteAndLeak?.(draft.sessionId);' +
    'this._clearCurrentNewSessionIfMatch(draft,!0);' +
    'this._onDidChangeSessions.fire({added:[],removed:[draftSession],changed:[]});' +
    'draft.dispose?.();' +
    '}' +
    'async _waitForRealizedAntigravitySession(beforeKeys,responseCreatedPromise,responseCompletePromise){' +
    'const findNew=includeUntitled=>{' +
    'for(const s of this.agentSessionsService?.model?.sessions??[]){' +
    'if(s.providerType!=="antigravity")continue;' +
    'const key=s.resource.toString();' +
    'if(beforeKeys.has(key))continue;' +
    'if(!includeUntitled&&s.resource.path.startsWith("/untitled-"))continue;' +
    'return s.resource;' +
    '}' +
    'return void 0;' +
    '};' +
    'const immediate=findNew(!1);' +
    'if(immediate)return immediate;' +
    'return await new Promise((resolve,reject)=>{' +
    'let done=!1,timer,sub;' +
    'const finish=(fn,val)=>{if(done)return;done=!0;if(timer)clearTimeout(timer);sub?.dispose?.();fn(val);};' +
    'sub=this.agentSessionsService?.model?.onDidChangeSessions?.(()=>{' +
    'const found=findNew(!1);' +
    'if(found)finish(resolve,found);' +
    '});' +
    'responseCreatedPromise?.then?.(res=>{' +
    'if(res?.isCanceled){const err=new Error("Canceled");err.name="Canceled";finish(reject,err);}' +
    '},()=>{});' +
    'responseCompletePromise?.then?.(()=>{setTimeout(()=>{' +
    'const found=findNew(!1)??findNew(!0);' +
    'if(found)finish(resolve,found);' +
    'else finish(reject,new Error("Antigravity session did not materialize"));' +
    '},50);},err=>finish(reject,err instanceof Error?err:new Error(String(err))));' +
    'timer=setTimeout(()=>{' +
    'const found=findNew(!1)??findNew(!0);' +
    'if(found)finish(resolve,found);' +
    'else finish(reject,new Error("Timed out waiting for Antigravity session commit"));' +
    '},300000);' +
    '});' +
    '}' +
    '}' +
    `if(Array.isArray(${xfeCls}.$di$dependencies)){` +
    `AntigravitySessionsProvider.$di$dependencies=[...${xfeCls}.$di$dependencies];` +
    'AntigravitySessionsProvider.$di$target=AntigravitySessionsProvider;' +
    '}' +
    `const agyProv=${disp}.add(${inst}.createInstance(AntigravitySessionsProvider,"antigravity"));` +
    `${disp}.add(${regSvc}.registerProvider(agyProv));`
  );
}

function buildSessionsChatInputPickerSnippet({ chatInput, expr, isSess, ctx }) {
  return `{id:${chatInput}.ChatInput,order:4,group:"navigation",when:${expr}.and(${isSess},${ctx}.chatSessionHasModels,${ctx}.chatSessionType.isEqualTo("antigravity"),${ctx}.lockedToCodingAgent)},`;
}

function buildSessionsNewModeViewItemSnippet({ reg, menuId, mgmtSvc }, { mutCls }) {
  return (
    `,this._register(${reg}.register(${menuId},"antigravity.newSessionModePicker",(action,_viewOpts,instantiation)=>{` +
    `const activeSvc=instantiation.invokeFunction(acc=>acc.get(${mgmtSvc}));` +
    'const provider=globalThis[Symbol.for("antigravity.sessionsProvider")];' +
    'const getSession=()=>activeSvc.session?.get?.();' +
    'const resolveGroup=()=>provider?.getModeOptionGroup?.(getSession())??{id:"mode",name:"Agent Mode",items:[],selected:void 0};' +
    'let currentGroup=resolveGroup();' +
    'const listeners=new Set;' +
    'const delegate={' +
    'onDidChangeOption:cb=>{listeners.add(cb);return{dispose(){listeners.delete(cb)}}},' +
    'setOption:opt=>{provider?.setNewSessionModeOption?.(getSession(),opt);currentGroup=resolveGroup();for(const cb of [...listeners])cb(opt);},' +
    'getOptionGroup:()=>{currentGroup=resolveGroup();return currentGroup;},' +
    'getCurrentOption:()=>resolveGroup().selected,' +
    'getSessionResource:()=>getSession()?.resource??{scheme:"antigravity"},' +
    '};' +
    `const picker=instantiation.createInstance(${mutCls},action,{group:currentGroup,item:currentGroup.selected},delegate,void 0);` +
    'const fireUpdate=()=>{currentGroup=resolveGroup();const next=currentGroup.selected;for(const cb of [...listeners])cb(next);};' +
    'if(provider?.onDidChangeOptionState)picker._register(provider.onDidChangeOptionState(fireUpdate));' +
    'if(provider?.chatSessionsService?.onDidChangeOptionGroups)picker._register(provider.chatSessionsService.onDidChangeOptionGroups(t=>{if(!t||t==="antigravity")fireUpdate();}));' +
    'return picker;' +
    '}))'
  );
}

function buildSessionsNewModeActionSnippet({ disp, regAct, actCls }, { expr, sessionsWin, ctx, tiKey, menuId }) {
  return (
    `${disp}.add(${regAct}(class extends ${actCls}{` +
    `constructor(){super({id:"antigravity.newSessionModePicker",title:"Agent Mode",menu:[{id:${menuId},group:"navigation",order:0,when:${expr}.and(${sessionsWin},${ctx}.enabled,${tiKey}.isEqualTo("antigravity"))}]})}` +
    'run(){}' +
    '}));'
  );
}

module.exports = {
  buildSessionsChatInputPickerSnippet,
  buildSessionsNewModeActionSnippet,
  buildSessionsNewModeViewItemSnippet,
  buildSessionsProviderSnippet,
};
