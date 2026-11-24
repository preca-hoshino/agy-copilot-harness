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
    'this._agySubagentChats=new Map;' +
    '}' +
    '_ensureAgySubagentChat(chatResourceStr,titleStr){' +
    'const uriCtor=this.resource?.constructor;' +
    'if(typeof uriCtor?.parse!=="function"||typeof chatResourceStr!=="string"||!chatResourceStr.startsWith("antigravity:/subagent/"))return void 0;' +
    'let chatUri;try{chatUri=uriCtor.parse(chatResourceStr);}catch{return void 0;}' +
    'const key=chatUri.toString();' +
    'const existing=this._agySubagentChats.get(key);' +
    'if(existing){' +
    'const cur=this._chatsObs?.get?.()??[];' +
    'if(!cur.some(x=>x?.resource?.toString?.()===key))this._chatsObs?.set?.([...cur,existing],void 0);' +
    'return existing;' +
    '}' +
    'const def=this._defaultChat;' +
    'const sampleObs=this._mainChatObs;' +
    'const obsCtor=sampleObs?.constructor;' +
    'const mkObs=(fallbackVal)=>obsCtor?new obsCtor(sampleObs._debugNameData,fallbackVal,sampleObs._equalityComparator):def?.description;' +
    'const canvases=typeof this._createChatCanvases==="function"?this._createChatCanvases():{};' +
    'const childChat={' +
    'resource:chatUri,' +
    'harness:def?.harness??this.harness,' +
    'createdAt:Date.now(),' +
    'workspace:def?.workspace,' +
    'title:mkObs(typeof titleStr==="string"&&titleStr.trim()?titleStr.trim():"Subagent"),' +
    'updatedAt:def?.updatedAt,' +
    'status:mkObs(2),' +
    'changes:def?.changes,' +
    'changesets:def?.changesets,' +
    'changesSummary:def?.changesSummary,' +
    'lastTurnChanges:mkObs([]),' +
    'customizations:mkObs([]),' +
    '...canvases,' +
    'observeChanges:def?.observeChanges,' +
    'backgroundShells:mkObs([]),' +
    'checkpoints:mkObs(void 0),' +
    'modelId:def?.modelId,' +
    'modelSource:def?.modelSource,' +
    'mode:def?.mode,' +
    'completedStateIcon:mkObs(void 0),' +
    'isArchived:def?.isArchived,' +
    'isRead:mkObs(!0),' +
    'interactivity:def?.interactivity,' +
    'description:mkObs(void 0),' +
    'lastTurnEnd:mkObs(void 0),' +
    'origin:{kind:"tool",parentChat:this.resource},' +
    '};' +
    'this._agySubagentChats.set(key,childChat);' +
    'this._aggregateChatResources?.add?.(chatUri);' +
    'const curChats=this._chatsObs?.get?.()??[];' +
    'if(!curChats.some(x=>x?.resource?.toString?.()===key)){' +
    'this._chatsObs?.set?.([...curChats,childChat],void 0);' +
    '}' +
    'return childChat;' +
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
    'update(session){' +
    'const changed=super.update(session);' +
    'this.icon={id:"antigravity-logo"};' +
    'if(this._agySubagentChats?.size>0&&this._chatsObs?.get){' +
    'const cur=this._chatsObs.get();' +
    'const missing=[];' +
    'for(const[k,c]of this._agySubagentChats){' +
    'if(!cur.some(x=>x?.resource?.toString?.()===k))missing.push(c);' +
    '}' +
    'if(missing.length>0)this._chatsObs.set([...cur,...missing],void 0);' +
    '}' +
    'return changed;' +
    '}' +
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
    'globalThis[Symbol.for("antigravity.ensureSubagentChat")]=(ctx,mgmt,hosts)=>{' +
    'const chatRes=typeof ctx?.chatResource==="string"?ctx.chatResource:"";' +
    'if(!chatRes.startsWith("antigravity:/subagent/"))return;' +
    'let session;' +
    'const parentRaw=typeof ctx?.parentSessionResource==="string"?ctx.parentSessionResource:"";' +
    'const parentNoFrag=parentRaw?parentRaw.split("#")[0].split("?")[0]:"";' +
    'if(parentNoFrag&&this._sessionCache){' +
    'session=this._sessionCache.get(parentNoFrag);' +
    'if(!session){' +
    'for(const s of this._sessionCache.values()){' +
    'if(s?.resource?.toString?.()?.split("?")[0]===parentNoFrag){session=s;break;}' +
    '}' +
    '}' +
    '}' +
    'if(!session&&hosts?.get){' +
    'for(const h of hosts.get()){' +
    'const hs=h?.session?.get?.();' +
    'if(hs?._ensureAgySubagentChat&&(!parentNoFrag||hs.resource?.toString?.()?.split("?")[0]===parentNoFrag)){session=hs;break;}' +
    '}' +
    '}' +
    'if(!session&&mgmt?.session?.get){' +
    'const active=mgmt.session.get();' +
    'if(active?._ensureAgySubagentChat)session=active;' +
    '}' +
    'session?._ensureAgySubagentChat?.(chatRes,ctx?.title);' +
    '};' +
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
    '_usesSandbox(){return!1;}' +
    '_validateSandboxSession(){}' +
    'getModelPickerOptions(){return{showUnavailableFeatured:!1,showManageModelsAction:!1,showAutoModel:!1};}' +
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
    'const sid=session?.sessionId||(typeof session?.resource?.path==="string"?session.resource.path.replace(/^\\/+/, ""):void 0);' +
    'const draft=sid?this._newSessions.get(sid):void 0;' +
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
    'const sid=session?.sessionId||(typeof session?.resource?.path==="string"?session.resource.path.replace(/^\\/+/, ""):void 0);' +
    'const draft=sid?this._newSessions.get(sid):void 0;' +
    'this._applyModeSelection(session,option,draft);' +
    '}' +
    'setActiveSessionModeOption(resource,option){' +
    'this._applyModeSelection({resource},option,void 0);' +
    '}' +
    '_applyModeSelection(session,option,draft){' +
    'const id=typeof option==="string"?option:option?.id;' +
    'if(!id)return;' +
    'this._agyLastModeId=id;' +
    'if(id!=="plan")this._agyLastInteractiveModeId=id;' +
    'const group=this.getModeOptionGroup(session);' +
    'const matched=group.items.find(item=>item.id===id)??option;' +
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
    'if(!draft.selectedOptions.has("mode")){' +
    'const g=this.getModeOptionGroup(draft);' +
    'const opt=(this._agyLastModeId?g.items.find(i=>i.id===this._agyLastModeId):void 0)??g.selected;' +
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

function buildSessionsNewModeViewItemSnippet({ reg, menuId, mgmtSvc }, { mutCls }, chatInputGroups) {
  const chatInput = chatInputGroups?.chatInput;
  const registrations =
    `this._register(${reg}.register(${menuId},"antigravity.newSessionModePicker",(a,v,i)=>_agyCreate(a,v,i,!1)));` +
    (chatInput
      ? `this._register(${reg}.register(${chatInput}.ChatInput,"antigravity.chatSessionModePicker",(a,v,i)=>_agyCreate(a,v,i,!0)));`
      : '');
  return (
    `,((_agyCreate=>{${registrations}})((action,_viewOpts,instantiation,isChatInput)=>{` +
    `const activeSvc=instantiation.invokeFunction(acc=>acc.get(${mgmtSvc}));` +
    'const provider=globalThis[Symbol.for("antigravity.sessionsProvider")];' +
    'let contextWidget=_viewOpts?.actionContext?.widget;' +
    'const getTarget=()=>{if(!isChatInput){const s=activeSvc.session?.get?.();return{session:s,resource:s?.resource};}' +
    'const widgetRes=contextWidget?.viewModel?.model?.sessionResource;' +
    'if(widgetRes?.scheme==="antigravity")return{session:{resource:widgetRes},resource:widgetRes};' +
    'const chatRes=activeSvc.chat?.get?.()?.resource;' +
    'if(chatRes?.scheme==="antigravity")return{session:{resource:chatRes},resource:chatRes};' +
    'const s=activeSvc.session?.get?.();return{session:s,resource:s?.resource};};' +
    'const resolveGroup=()=>provider?.getModeOptionGroup?.(getTarget().session)??{id:"mode",name:"Agent Mode",items:[],selected:void 0};' +
    'let currentGroup=resolveGroup();' +
    'const listeners=new Set;' +
    'const delegate={' +
    'onDidChangeOption:cb=>{listeners.add(cb);return{dispose(){listeners.delete(cb)}}},' +
    'setOption:opt=>{' +
    'const{session,resource}=getTarget();' +
    'if(isChatInput){' +
    'const rawId=typeof resource?.path==="string"?resource.path.replace(/^\\/+/, ""):"";' +
    'const draft=rawId?provider?._newSessions?.get?.(rawId):void 0;' +
    'if(draft)provider?.setNewSessionModeOption?.(draft,opt);' +
    'else provider?.setActiveSessionModeOption?.(resource,opt);' +
    '}else{provider?.setNewSessionModeOption?.(session,opt);}' +
    'currentGroup=resolveGroup();const next=currentGroup.selected??opt;for(const cb of [...listeners])cb(next);' +
    '},' +
    'getOptionGroup:()=>{currentGroup=resolveGroup();return currentGroup;},' +
    'getCurrentOption:()=>resolveGroup().selected,' +
    'getSessionResource:()=>getTarget().resource??{scheme:"antigravity"},' +
    '};' +
    `const picker=instantiation.createInstance(${mutCls},action,{group:currentGroup,item:currentGroup.selected},delegate,void 0);` +
    'const fireUpdate=()=>{currentGroup=resolveGroup();const next=currentGroup.selected;for(const cb of [...listeners])cb(next);};' +
    'let vmSub;' +
    'if(isChatInput){' +
    'const origSetCtx=picker.setActionContext?.bind(picker);' +
    'if(origSetCtx){picker.setActionContext=ctx=>{origSetCtx(ctx);const nextW=ctx?.widget;if(nextW!==contextWidget){contextWidget=nextW;vmSub?.dispose?.();vmSub=nextW?.onDidChangeViewModel?.(fireUpdate);fireUpdate();}};}' +
    'if(contextWidget?.onDidChangeViewModel)vmSub=contextWidget.onDidChangeViewModel(fireUpdate);' +
    'picker._register({dispose(){vmSub?.dispose?.();vmSub=void 0;}});' +
    '}' +
    'if(provider?.onDidChangeOptionState)picker._register(provider.onDidChangeOptionState(fireUpdate));' +
    'if(provider?.chatSessionsService?.onDidChangeOptionGroups)picker._register(provider.chatSessionsService.onDidChangeOptionGroups(t=>{if(!t||t==="antigravity")fireUpdate();}));' +
    'if(isChatInput&&provider?.chatSessionsService?.onDidChangeSessionOptions)picker._register(provider.chatSessionsService.onDidChangeSessionOptions(ev=>{const cur=getTarget().resource;if(!cur||!ev?.sessionResource||cur.toString?.()===ev.sessionResource.toString?.())fireUpdate();}));' +
    'return picker;' +
    '}))'
  );
}

function buildSessionsNewModeActionSnippet({ disp, regAct, actCls }, { expr, sessionsWin, ctx, tiKey, menuId }, chatInputGroups) {
  const buildAction = (id, targetMenuId, order, whenExpr) =>
    `${disp}.add(${regAct}(class extends ${actCls}{` +
    `constructor(){super({id:"${id}",title:"Agent Mode",menu:[{id:${targetMenuId},group:"navigation",order:${order},when:${whenExpr}}]})}` +
    'run(){}' +
    '}));';
  const newSessionAct = buildAction(
    'antigravity.newSessionModePicker',
    menuId,
    0,
    `${expr}.and(${sessionsWin},${ctx}.enabled,${tiKey}.isEqualTo("antigravity"))`,
  );
  const { chatInput, isSess } = chatInputGroups || {};
  const chatInputAct =
    chatInput && isSess
      ? buildAction(
          'antigravity.chatSessionModePicker',
          `${chatInput}.ChatInput`,
          '.5',
          `${expr}.and(${isSess},${ctx}.enabled,${ctx}.chatSessionType.isEqualTo("antigravity"),${expr}.equals("sessionUsesExperimentalComposerLayout",!0))`,
        )
      : '';
  return newSessionAct + chatInputAct;
}

function buildSessionsSubagentOpenerSnippet({ arg, mgmt, hosts }) {
  return `globalThis[Symbol.for("antigravity.ensureSubagentChat")]?.(${arg},${mgmt},${hosts});`;
}

function buildSessionsSubagentTrackSnippet({ item }, { mgmt, hosts }) {
  return (
    `if(${item}?.trackEnabled){const _agyOrigTrack=${item}.trackEnabled.bind(${item});` +
    `${item}.trackEnabled=cb=>_agyOrigTrack((g,f)=>{` +
    `if(typeof g?.chatResource==="string"&&g.chatResource.startsWith("antigravity:/subagent/")){` +
    `queueMicrotask(()=>{globalThis[Symbol.for("antigravity.ensureSubagentChat")]?.(g,${mgmt},${hosts});});` +
    `f(!0);return{dispose(){}};` +
    `}return cb(g,f);});}` +
    `if(${item}?.setDragDataProvider){const _agyOrigDrag=${item}.setDragDataProvider.bind(${item});` +
    `${item}.setDragDataProvider=cb=>_agyOrigDrag((g,f)=>{` +
    `if(typeof g?.chatResource==="string"&&g.chatResource.startsWith("antigravity:/subagent/")){` +
    `globalThis[Symbol.for("antigravity.ensureSubagentChat")]?.(g,${mgmt},${hosts});` +
    `}return cb(g,f);});}`
  );
}

module.exports = {
  buildSessionsNewModeActionSnippet,
  buildSessionsNewModeViewItemSnippet,
  buildSessionsProviderSnippet,
  buildSessionsSubagentOpenerSnippet,
  buildSessionsSubagentTrackSnippet,
};
