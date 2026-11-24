import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireFromProject = createRequire(join(process.cwd(), 'package.json'));
const { runApply }: { runApply: (root: string) => void } = requireFromProject('./scripts/ui-patch/lifecycle.js');
const cli = join(process.cwd(), 'scripts', 'patch-sessions-ui.js');
const backgroundFooter = '/*ext-backgroundCover-start*/\n/*ext.backgroundCover.bootstrap.1*/\n;void 0;/*ext-backgroundCover-end*/';

function commonBundle() {
  return [
    'function update(e){let n=e.tooltip,i;let r=$markdown(n)?{markdown:n,markdownNotSupportedFallback:void 0}:n;this.hover?this.hover.update(r,i):this.hover=this._register(this.hoverService.setupManagedHover(this.hoverDelegate,this.container,r,i))}',
    'class Auth{readAllowedExtensions(e,t){let i=[];try{let a=this._storageService.get(`${e}-${t}`,-1);a&&(i=JSON.parse(a))}catch{}let n=this._productService.trustedExtensionAuthAccess,r=Array.isArray(n)?n:typeof n=="object"?n[e]??[]:[];return r}}',
    'function $session(s){return s.scheme===schemes.vscodeChatEditor?local:s.scheme===uri.scheme?s.authority||local:s.scheme}',
    'class SessionRenderer{renderHarness($row,$template){let $provider=$knownProvider($row.providerType),$icon=$provider?$providerIcon($provider):$row.icon;$template.harnessIcon.className=`agent-session-harness-icon ${$themeIcon.asClassName($icon)}`}}',
    'class AgentSessionsModel{isArchived(e){return!!e.archived}setArchived(){}isPinned(){return!1}setPinned(){}isRead(){return!0}isMarkedUnread(){return!1}setRead(){}toAgentSession($item){return{...$item,children:$item.children?.map(t=>this.toAgentSession(t)),isArchived:()=>this.isArchived($item),setArchived:t=>this.setArchived($item,t),isPinned:()=>this.isPinned($item),setPinned:t=>this.setPinned($item,t),isRead:()=>this.isRead($item),isMarkedUnread:()=>this.isMarkedUnread($item),setRead:t=>this.setRead($item,t)}}}',
    'class ChatSessionsService{constructor(contributions){this._contributions=contributions}supportsDelegationForSessionType($type){return this._contributions.get($type)?.contribution?.supportsDelegation!==!1}}',
    'function external(e){let n={id:e.toolName,source:$source.External,displayName:e.toolName,modelDescription:e.toolName},r=new $invocation({invocationMessage:e.invocationMessage,pastTenseMessage:e.pastTenseMessage,toolSpecificData:e.toolSpecificData},n);return r}',
    'class Agent{answer(e){this._proxy.$handleQuestionCarouselAnswer(e)}async $handleProgressChunk(e,t){let i=this._pendingProgress.get(e);let{progress:n,chatSession:r,isSubagent:a}=i,c=[],l=r?.getRequests().find(u=>u.id===e)?.response;for(let u of t){let[p,h]=Array.isArray(u)?u:[u];if(p.kind==="externalEdits"){if(r?.editingSession&&h!==void 0&&l){let f=p.start?await r.editingSession.startExternalEdits(l,h,$revive(p.resources),p.undoStopId):await r.editingSession.stopExternalEdits(l,h);c.push(...f)}continue}if(p.kind==="beginToolInvocation"){c.push(p);continue}c.push(p)}n(c)}}',
    'class RemoteSession{async _doInitializeContent(e,t){let i=await this._proxy.$provideChatSessionContent();this.history.length=0;this.history.push(...i.history.map(c=>{if(c.type==="request")return c;return{type:"response",parts:c.parts.map(l=>$revive(l)),participant:c.participant,details:c.details}})),i.hasActiveResponseCallback&&void 0,i.hasForkHandler&&!this.forkSession&&(this.forkSession=async(c,l)=>{let u=await this._proxy.$forkChatSession(this._providerHandle,this.sessionResource,c?this.toRequestDto(c):void 0,l);return $revive(u)})}}',
    'class EditingWidget{renderChatEditingSessionWithEntries(e,t,i,n){let C=i.read(e),k=n.read(e);return C.concat(k)}}',
    'class ChatSvc{notifyQuestionCarouselAnswer(e,t,i){this._onDidReceiveQuestionCarouselAnswer.fire({requestId:e,resolveId:t,answers:i})}track(w,p,e,c,x){if(c&&w.length>p){let D=w.slice(p);for(let O of D)e?.acceptResponseProgress(c,O,void 0,x);p=w.length}}notifyUserAction(e){if(this._chatServiceTelemetry.notifyUserAction(e),this._onDidPerformUserAction.fire(e),e.action.kind==="chatEditingSessionAction"){let t=this._sessionModels.get(e.sessionResource);t&&t.notifyEditingAction(e.action)}}}',
    'class ChatOptionPicker{renderLabel(e){let t=[];e.classList.add("chat-session-option-picker");let i=this.delegate.getOptionGroup(),n=this._pickerOptions?.compact.get()??!1;e.classList.toggle("compact",n);let r=this.currentOption?.name??i?.description??$d(15978,null),a=this.currentOption?.default&&this.currentOption?.icon;return e.classList.toggle("icon-only",n&&!!this.currentOption?.icon),this.currentOption?.icon&&t.push($ko($qu(this.currentOption.icon))),!a&&(!n||!this.currentOption?.icon)&&t.push($dom("span.chat-session-option-label",void 0,r)),$reset(e,...t),this.setAriaLabelAttributes(e),e.ariaLabel=r,null}}',
  ].join('\r\n');
}

const sessionsOriginal = `${commonBundle()}
var $chat=token("chatStatusItemService");
var $BaseOpt=typeof BaseOptionPicker!=="undefined"?BaseOptionPicker:class{_register(d){return d}getDropdownActions(){return[]}};
var $BaseCon=typeof BaseContrib!=="undefined"?BaseContrib:class{_register(x){return x}};
var $Disp=typeof DispStore!=="undefined"?DispStore:class{add(x){return x}};
var $Act2=typeof $Action2!=="undefined"?$Action2:class{constructor(d){this.desc=d}};
var $ExprObj=typeof $Expr!=="undefined"?$Expr:{and:(...xs)=>({and:xs}),or:(...xs)=>({or:xs}),equals:(k,v)=>({eq:[k,v]})};
var $CtxObj=typeof $Ctx!=="undefined"?$Ctx:{enabled:1,chatSessionHasModels:1,lockedToCodingAgent:1,chatSessionType:{isEqualTo:v=>({eq:v}),notEqualsTo:v=>({neq:v})}};
var $ProvObj=typeof $Provider!=="undefined"?$Provider:{Cloud:"cloud",Background:"bg"};
var $IsSessObj=typeof $IsSessions!=="undefined"?$IsSessions:{negate:()=>1};
var $SessWinVal=typeof $SessionsWin!=="undefined"?$SessionsWin:1;
var $TiKeyObj=typeof $TiKey!=="undefined"?$TiKey:{isEqualTo:v=>({ti:v})};
var $SandboxVal=typeof $SandboxProv!=="undefined"?$SandboxProv:"sandbox";
var $SqaVal=typeof _sqa!=="undefined"?_sqa:1;
var $MenuObj=typeof $MenuId!=="undefined"?$MenuId:{ChatInput:"ChatInput",ChatInputSecondary:"ChatInputSecondary"};
var $WtObj=typeof $Wt!=="undefined"?$Wt:{NewSessionControl:"NewSessionControl"};
var $SlVal=typeof $Sl!=="undefined"?$Sl:"sl";
var $RegActFn=typeof $regAction!=="undefined"?$regAction:(C)=>new C();
var $UriObj=typeof $URI!=="undefined"?$URI:{parse:r=>({scheme:"unknown",path:"///",toString:()=>r}),from:({scheme,path})=>({scheme,path,toString:()=>scheme+":"+path})};
var $ObsFn=typeof $obs!=="undefined"?$obs:(v=>({get:()=>v}));
var $EmitFn=typeof $makeEmitter!=="undefined"?$makeEmitter:(()=>({event:()=>({dispose(){}}),fire:()=>{}}));
var $UuidFn=typeof $uuid!=="undefined"?$uuid:(()=>"u");
function $getModels(lms){return lms.getLanguageModelIds().map(id=>{let meta=lms.lookupLanguageModel(id);return meta?{identifier:id,metadata:meta}:void 0}).filter(x=>x!==void 0)}function $noop(){}function $resolveModel(models,desired,lms,all){return $resolveInner(models,desired,{hasLiveModels:()=>!0})}
var $mut=class extends $BaseOpt{constructor(e,t,i,n,r,a,c,l,u,p,h){let{group:g,item:f}=t,v=e;super(v,t,i,n,r,a,c,l,u,p,h);this._actions={getActions:()=>this.getDropdownActions()}}getDropdownActions(){return[]}};
const ChatPickerMenu=[{id:$MenuObj.ChatInput,order:4,group:"navigation",when:$ExprObj.and($CtxObj.chatSessionHasModels,$CtxObj.chatSessionType.isEqualTo($ProvObj.Cloud),$CtxObj.lockedToCodingAgent)},{id:$MenuObj.ChatInputSecondary,order:4,group:"navigation",when:$ExprObj.and($CtxObj.chatSessionHasModels,$CtxObj.chatSessionType.notEqualsTo($ProvObj.Cloud),$ExprObj.or($IsSessObj.negate(),$CtxObj.chatSessionType.notEqualsTo($ProvObj.Background)),$CtxObj.lockedToCodingAgent)}];
var _x=$ExprObj.and($SessWinVal,$CtxObj.enabled,$ExprObj.or($SqaVal,$TiKeyObj.isEqualTo($SandboxVal))),G4e=class extends $BaseCon{static{this.ID="workbench.contrib.copilotPickerActionViewItems"}constructor(reg,layout){super(),this._register(reg.register($WtObj.NewSessionControl,"sessions.sandbox.modePicker",(t,i,n)=>{let r=n.invokeFunction(a=>a.get($SlVal));return new ViewItem(n)}))}};
function dis(){let disp=new $Disp;for(let[id,title,order]of[["sessions.sandbox.modePicker","Agent Mode",0],["sessions.sandbox.approvalPicker","Approvals",1]])disp.add($RegActFn(class extends $Act2{constructor(){super({id,title,menu:[{id:$WtObj.NewSessionControl,group:"navigation",order,when:_x}]})}run(){}}));return disp}
class $Draft{constructor(res,ws,target,prov){this.resource=res;this.sessionWorkspace=ws;this.target=target;this.providerId=prov;this.sessionType=target;this.sessionId=prov+":"+res.toString();this.selectedOptions=new Map;this.mainChat=$ObsFn({resource:res})}setCreatedBySession(){}setOption(k,v){this.selectedOptions.set(k,v)}setTitle(){}setStatus(){}dispose(){}}
class $CacheItem{constructor(s,pid,gh,pr,log){this.sessionId=pid+":"+s.resource.toString();this.resource=s.resource;this.providerId=pid;this.sessionType=s.providerType;this.icon={id:"cloud"};this.status=$ObsFn(0);this.workspace=$ObsFn(this._buildWorkspace(s));this.mainChat=$ObsFn({resource:s.resource})}update(){return!1}_buildWorkspace(s){return{uri:$UriObj.parse("unknown:///"),label:"u",icon:{id:"folder"},group:"o",folders:[{root:$UriObj.parse("unknown:///"),workingDirectory:$UriObj.parse("unknown:///"),name:"u"}],requiresWorkspaceTrust:!1,isVirtualWorkspace:!0}}}
class $Xfe{get id(){return this.providerMode==="sandbox"?"sandbox":"default"}constructor(mode,agentSessionsService,chatService,chatSessionsService,commandService,instantiationService,languageModelsService){this.providerMode=mode;this.agentSessionsService=agentSessionsService;this.chatService=chatService;this.chatSessionsService=chatSessionsService;this.commandService=commandService;this.instantiationService=instantiationService;this.languageModelsService=languageModelsService;this._sessionCache=new Map;this._sessionWrapperCache=new Map;this._newSessions=new Map;this._inFlightCommits=new Set;this._onDidChangeSessionTypes=$EmitFn();this.onDidChangeSessionTypes=this._onDidChangeSessionTypes.event;this._onDidChangeSessions=$EmitFn();this.onDidChangeSessions=this._onDidChangeSessions.event;this._onDidReplaceSession=$EmitFn();this.onDidReplaceSession=this._onDidReplaceSession.event;this._store={add(){}};this._register=x=>x;this._refreshSessionCache()}createNewSession(e,t,i){return this._createDraftSession(e,t,i)}resolveWorkspace(e){if(e&&e.scheme==="file")return{uri:e,label:"ws",folders:[{root:e,workingDirectory:e,name:"ws"}],requiresWorkspaceTrust:!0,isVirtualWorkspace:!1}}_createDraftSession(e,t,i){if(this._assertCloudSessionsEnabled()){}let c="cloud",uUri=$UriObj.from({scheme:c,path:\`/untitled-\${$UuidFn()}\`}),draft=this.instantiationService.createInstance($Draft,uUri,void 0,t,this.id);return this._chatToSession(draft)}_refreshSessionCache(){if(this.providerMode==="sandbox")return;for(let a of this.agentSessionsService.model.sessions){if(a.providerType!=="cloud")continue;let u=new $CacheItem(a,this.id,this.gitHubService,this.pullRequestIconCache,this.logService);this._sessionCache.set(a.resource.toString(),u)}}_chatToSession(e){return{sessionId:e.sessionId,resource:e.resource,providerId:e.providerId,sessionType:e.sessionType,harness:"copilot",environment:this.environment?.id,icon:e.icon,mainChat:e.mainChat,workspace:e.workspace}}_replaceSession(){}_clearCurrentNewSessionIfMatch(){}_waitForSessionInCache(){}_updateChatSessionState(){}}
function Nos(services){let inst=services.get($InstToken),regSvc=services.get($ProvidersToken),a=0,disp=new $Disp,prov=disp.add(inst.createInstance($Xfe,"default"));if(disp.add(regSvc.registerProvider(prov)),false){}return disp}
class Panel{createCombinedPanelContent(e){let t=$element("div"),l=$append(t,$element(".sessions-account-titlebar-panel-identities"));
if(this.accountName){let v=e.add(new $bar(l));e.add(v.onWillRun(()=>{this.hoverService.hideHover(!0),this.clickPanelDisposable.clear()})),v.push(e.add(new $action("copilot.manageModels","Models")))}
if(this.chatEntitlementService.sentiment.hidden||e.add(this.instantiationService.createInstance(Widget,t))){}return t}
renderContributedSections(e){for(let t of e){this.render(t)}}}
`;
const workbenchOriginal = `${commonBundle()}
class Menu{resolveMainMenuActions(e,t){let r=[],h=[],u=[],p=()=>{};if(h.length){r.length&&r.push(new $separator);for(let g of h)r.push(g instanceof Action?t.add(g):g)}return p(u),r}}
`;

function backupPath(file: string, original: string) {
  const hash = createHash('sha256').update(original).digest('hex');
  return `${file}.agy-harness-${hash}.bak`;
}

let root: string;
let sessions: string;
let workbench: string;

function runPatch(mode: '--apply' | '--check' | '--unpatch') {
  const result = spawnSync(process.execPath, [cli, mode, '--vscode-root', root], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'agy-ui-patch-test-'));
  sessions = join(root, 'sessions', 'sessions.desktop.main.js');
  workbench = join(root, 'workbench', 'workbench.desktop.main.js');
  for (const [file, original] of [[sessions, sessionsOriginal], [workbench, workbenchOriginal]] as const) {
    fs.mkdirSync(dirname(file));
    fs.writeFileSync(file, original);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VS Code UI patch lifecycle', () => {
  it('captures renamed aliases, applies idempotently, and restores exact bytes while retaining backups', () => {
    expect(runPatch('--check')).toMatchObject({ status: 0, output: expect.stringContaining('unpatched, anchors verified') });
    expect(runPatch('--apply')).toMatchObject({ status: 0, output: expect.stringContaining('Patched (v1)') });
    const patchedSessions = fs.readFileSync(sessions, 'utf8');
    const patchedWorkbench = fs.readFileSync(workbench, 'utf8');
    expect(patchedSessions).toContain('_agyAcc.get($chat)');
    expect(patchedSessions).toContain('_agyAction=$action');
    expect(patchedSessions).toContain('$session(r.sessionResource)==="antigravity"');
    expect(patchedSessions).toContain('p,e,l,$invocation,$source.External,');
    expect(patchedSessions).toContain(':v1:live-edit-pill:');
    expect(patchedWorkbench).toContain('_act instanceof $separator');
    expect(runPatch('--check')).toMatchObject({ status: 0, output: expect.stringContaining('backup=verified') });
    expect(runPatch('--apply')).toMatchObject({ status: 0, output: expect.stringContaining('Already up to date') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(patchedSessions);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(patchedWorkbench);
    expect(runPatch('--unpatch')).toMatchObject({ status: 0, output: expect.stringContaining('Restored original') });
    for (const [file, original] of [[sessions, sessionsOriginal], [workbench, workbenchOriginal]] as const) {
      expect(fs.readFileSync(file)).toEqual(Buffer.from(original));
      expect(fs.readFileSync(backupPath(file, original))).toEqual(Buffer.from(original));
    }
  });

  it('renders the Antigravity logo in both session lists without changing other providers', () => {
    expect(runPatch('--apply').status).toBe(0);
    for (const file of [sessions, workbench]) {
      const render: (providerType: string, id: string) => string = runInNewContext(`
        ${fs.readFileSync(file, 'utf8')}
        (providerType, id) => {
          const template = { harnessIcon: { className: '' } };
          new SessionRenderer().renderHarness({ providerType, icon: { id } }, template);
          return template.harnessIcon.className;
        };
      `, {
        token: vi.fn(),
        $knownProvider: (type: string) => (type === 'local' ? type : undefined),
        $providerIcon: () => ({ id: 'vm' }),
        $themeIcon: { asClassName: ({ id }: { id: string }) => `codicon codicon-${id}` },
      });
      expect(render('antigravity', 'terminal')).toBe('agent-session-harness-icon codicon codicon-antigravity-logo');
      expect(render('other', 'terminal')).toBe('agent-session-harness-icon codicon codicon-terminal');
      expect(render('local', 'terminal')).toBe('agent-session-harness-icon codicon codicon-vm');
    }
  });

  it('normalizes the Antigravity session model icon (and child sessions) for hover headers and pickers without changing other providers', () => {
    expect(runPatch('--apply').status).toBe(0);
    for (const file of [sessions, workbench]) {
      const resolveIcons: () => { agyIcon: string; agyChildIcon: string; otherIcon: string; archived: boolean } = runInNewContext(`
        ${fs.readFileSync(file, 'utf8')}
        () => {
          const model = new AgentSessionsModel();
          const agy = model.toAgentSession({
            providerType: 'antigravity',
            icon: { id: 'terminal' },
            archived: true,
            children: [{ providerType: 'antigravity', icon: { id: 'terminal' } }],
          });
          const other = model.toAgentSession({ providerType: 'other', icon: { id: 'terminal' } });
          return {
            agyIcon: agy.icon.id,
            agyChildIcon: agy.children[0].icon.id,
            otherIcon: other.icon.id,
            archived: agy.isArchived(),
          };
        };
      `, { token: vi.fn() });
      expect(resolveIcons()).toEqual({
        agyIcon: 'antigravity-logo',
        agyChildIcon: 'antigravity-logo',
        otherIcon: 'terminal',
        archived: true,
      });
    }
  });

  it('disables in-session delegation for Antigravity without changing other providers', () => {
    expect(runPatch('--apply').status).toBe(0);
    for (const file of [sessions, workbench]) {
      const supportsDelegation: (type: string) => boolean = runInNewContext(`
        ${fs.readFileSync(file, 'utf8')}
        const service = new ChatSessionsService(new Map([
          ['antigravity', { contribution: { canDelegate: true } }],
          ['other-acp', { contribution: { supportsDelegation: false } }],
        ]));
        (type) => service.supportsDelegationForSessionType(type);
      `, { token: vi.fn() });
      expect(supportsDelegation('antigravity')).toBe(false);
      expect(supportsDelegation('local')).toBe(true);
      expect(supportsDelegation('other-acp')).toBe(false);
    }
  });

  it('renders the 2-tier Mode + Permissions split picker and collapsible popup for antigravity in both bundles', () => {
    expect(runPatch('--apply').status).toBe(0);
    for (const file of [sessions, workbench]) {
      const makeEl = (tag = 'div', className = '', text = '') => {
        const listeners = new Map<string, Array<(ev: unknown) => void>>();
        const attrs = new Map<string, string>();
        const classes = new Set<string>(className.split('.').filter(Boolean));
        const node: Record<string, unknown> = {
          tagName: tag.toUpperCase(),
          textContent: text,
          role: '',
          tabIndex: 0,
          ariaLabel: '',
          ariaHasPopup: undefined,
          ariaExpanded: 'false',
          ariaDisabled: undefined,
          ariaHidden: undefined,
          style: {} as Record<string, string>,
          parentElement: null as unknown,
          children: [] as unknown[],
          classList: {
            add: (...cls: string[]) => cls.forEach((c) => c && classes.add(c)),
            remove: (...cls: string[]) => cls.forEach((c) => classes.delete(c)),
            toggle: (c: string, force?: boolean) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c)),
            contains: (c: string) => classes.has(c),
            toArray: () => [...classes],
          },
          setAttribute: (k: string, v: string) => attrs.set(k, String(v)),
          removeAttribute: (k: string) => attrs.delete(k),
          getAttribute: (k: string) => attrs.get(k),
          addEventListener: (type: string, cb: (ev: unknown) => void) => {
            const arr = listeners.get(type) ?? [];
            arr.push(cb);
            listeners.set(type, arr);
          },
          dispatch: (type: string, ev: Record<string, unknown>) => {
            for (const cb of listeners.get(type) ?? []) cb({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...ev });
          },
          focus: vi.fn(),
        };
        return node;
      };
      const showCalls: unknown[][] = [];
      const setOption = vi.fn();
      const executeCommand = vi.fn();
      const result = runInNewContext(
        `
        ${fs.readFileSync(file, 'utf8')}
        const agyGroup = {
          id: 'mode',
          name: 'Agent Mode',
          items: [
            { id: 'default', name: 'Default', icon: { id: 'shield' }, agyPickerMeta: { provider: 'antigravity', pickerLabel: 'Manual permissions', shortLabel: 'Manual', tone: '', lastInteractiveMode: 'default' } },
            { id: 'auto', name: 'Auto', icon: { id: 'zap' }, agyPickerMeta: { provider: 'antigravity', pickerLabel: 'Auto', shortLabel: 'Auto', tone: 'warning', lastInteractiveMode: 'auto' } },
            { id: 'plan', name: 'Plan', icon: { id: 'checklist' }, agyPickerMeta: { provider: 'antigravity', pickerLabel: 'Plan', shortLabel: 'Plan', tone: '', lastInteractiveMode: 'auto' } },
          ],
          selected: undefined,
        };
        agyGroup.selected = agyGroup.items[1];
        const picker = new ChatOptionPicker();
        picker.container = $dom('div.action-item');
        picker.element = $dom('a.action-label');
        picker.currentOption = agyGroup.selected;
        picker._action = { enabled: true };
        picker._actionWidgetService = { isVisible: false, show: (...args) => __showCalls.push(args), hide: () => {} };
        picker.commandService = { executeCommand: __exec };
        picker.actionWidgetOptions = { listOptions: { className: 'base-cls', widgetClassName: 'base-widget' } };
        picker.setAriaLabelAttributes = (node) => node.setAttribute('aria-haspopup', 'true');
        picker.delegate = {
          getOptionGroup: () => agyGroup,
          getSessionResource: () => ({ scheme: 'antigravity' }),
          setOption: __setOption,
        };
        picker.renderLabel(picker.element);
        const [modeBtn, permBtn] = picker.element.children;
        permBtn.dispatch('mousedown', { button: 0 });
        const permOpenArgs = __showCalls[0];
        permOpenArgs[3].onHide();
        modeBtn.dispatch('keydown', { key: 'Enter' });
        const modeOpenArgs = __showCalls[1];

        // Non-antigravity group falls back to original renderLabel
        const otherEl = $dom('a.action-label');
        const otherPicker = new ChatOptionPicker();
        otherPicker.currentOption = { id: 'other', name: 'Other', icon: { id: 'circle' } };
        otherPicker.setAriaLabelAttributes = (node) => node.setAttribute('aria-haspopup', 'true');
        otherPicker.delegate = {
          getOptionGroup: () => ({ id: 'mode', description: 'Other', items: [] }),
          getSessionResource: () => ({ scheme: 'copilotcli' }),
        };
        otherPicker.renderLabel(otherEl);
        ({
          modeText: modeBtn.children[1].textContent,
          permText: permBtn.children[0].textContent,
          permClasses: permBtn.children[0].classList.toArray(),
          permOpenCollapsed: [...permOpenArgs[8].collapsedByDefault],
          modeOpenCollapsed: [...modeOpenArgs[8].collapsedByDefault],
          popupWidgetClass: modeOpenArgs[8].widgetClassName,
          otherElPopup: otherEl.getAttribute('aria-haspopup'),
          otherElIsSplit: otherEl.classList.contains('agent-host-mode-permissions-trigger'),
        });
        `,
        {
          token: vi.fn(),
          __showCalls: showCalls,
          __setOption: setOption,
          __exec: executeCommand,
          $d: () => 'Pick Option',
          $ko: (icon: unknown) => makeEl('span', `codicon codicon-${(icon as { id?: string })?.id ?? ''}`),
          $qu: (icon: unknown) => icon,
          $dom: (sel: string, _attrs?: unknown, text?: string) => makeEl(sel.split('.')[0] || 'div', sel.split('.').slice(1).join('.'), text ?? ''),
          $reset: (target: Record<string, unknown>, ...kids: unknown[]) => {
            target.children = kids;
          },
        },
      );
      expect(result).toEqual({
        modeText: 'Interactive',
        permText: 'Auto',
        permClasses: ['agent-host-mode-permission-summary', 'warning'],
        permOpenCollapsed: ['agentHostModePicker.mode'],
        modeOpenCollapsed: ['agentHostModePicker.permissions'],
        popupWidgetClass: 'base-widget agent-host-mode-permissions-popup',
        otherElPopup: 'true',
        otherElIsSplit: false,
      });
    }
  });

  it('updates both patched bundles after BackgroundCover replaces their final line endings', () => {
    const originals = [[sessions, sessionsOriginal], [workbench, workbenchOriginal.replace(/\r?\n$/, '\r\n')]] as const;
    fs.writeFileSync(workbench, originals[1][1]);
    expect(runPatch('--apply').status).toBe(0);
    const customized = (bundle: string) => bundle.replace(/\r?\n$/, '') + backgroundFooter;
    const patched = originals.map(([file]) => customized(fs.readFileSync(file, 'utf8')));
    for (const [index, [file]] of originals.entries()) {
      fs.writeFileSync(file, patched[index] ?? '');
    }

    expect(runPatch('--check')).toMatchObject({ status: 0, output: expect.stringContaining('backup=verified') });
    expect(runPatch('--apply')).toMatchObject({ status: 0, output: expect.stringContaining('Already up to date') });
    expect(runPatch('--unpatch')).toMatchObject({ status: 0, output: expect.stringContaining('preserved BackgroundCover') });
    for (const [file, original] of originals) {
      expect(fs.readFileSync(file, 'utf8')).toBe(customized(original));
      expect(fs.readFileSync(backupPath(file, original), 'utf8')).toBe(original);
    }
  });

  it('preserves the BackgroundCover footer when applying and removing the first Antigravity patch', () => {
    fs.writeFileSync(sessions, sessionsOriginal + backgroundFooter);
    expect(runPatch('--apply').status).toBe(0);
    expect(runPatch('--check')).toMatchObject({ status: 0, output: expect.stringContaining('backup=verified') });
    expect(runPatch('--unpatch').status).toBe(0);
    expect(fs.readFileSync(sessions, 'utf8')).toBe(sessionsOriginal + backgroundFooter);
  });

  it('preserves BackgroundCover while upgrading a legacy patch with an exact backup', () => {
    const customized = sessionsOriginal + backgroundFooter;
    fs.writeFileSync(sessions, `/*AGY_HARNESS_PATCH_START*/void 0;/*AGY_HARNESS_PATCH_END*/${customized}`);
    fs.writeFileSync(`${sessions}.bak`, customized);
    expect(runPatch('--apply').status).toBe(0);
    expect(runPatch('--check').status).toBe(0);
    expect(runPatch('--unpatch').status).toBe(0);
    expect(fs.readFileSync(sessions, 'utf8')).toBe(customized);
    expect(fs.readFileSync(`${sessions}.bak`, 'utf8')).toBe(customized);
  });

  it.each([
    ['an incomplete footer', backgroundFooter.replace('/*ext-backgroundCover-end*/', '')],
    ['a duplicate footer', backgroundFooter + backgroundFooter],
    ['a footer followed by another edit', `${backgroundFooter}\n;void 1;`],
  ])('refuses to adopt %s as part of an unpatched bundle', (_name, suffix) => {
    fs.writeFileSync(workbench, workbenchOriginal + suffix);
    expect(runPatch('--apply')).toMatchObject({ status: 1, output: expect.stringContaining('Unrecognized BackgroundCover footer') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(sessionsOriginal);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(workbenchOriginal + suffix);
    expect(fs.readdirSync(dirname(sessions))).toEqual(['sessions.desktop.main.js']);
  });

  it('still refuses unknown bundle edits when a BackgroundCover footer is present', () => {
    expect(runPatch('--apply').status).toBe(0);
    const patchedSessions = fs.readFileSync(sessions, 'utf8');
    const altered = fs.readFileSync(workbench, 'utf8').replace('class Menu', 'class ChangedMenu') + backgroundFooter;
    fs.writeFileSync(workbench, altered);
    expect(runPatch('--apply')).toMatchObject({ status: 1, output: expect.stringContaining('outside patch markers') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(patchedSessions);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(altered);
  });

  it('rejects changed anchors in the second bundle before modifying either bundle or creating backups', () => {
    const unsupported = workbenchOriginal.replace('markdownNotSupportedFallback', 'differentTooltipShape');
    fs.writeFileSync(workbench, unsupported);
    expect(runPatch('--apply')).toMatchObject({ status: 1, output: expect.stringContaining('Anchor not found: status bar tooltip') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(sessionsOriginal);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(unsupported);
    expect(fs.readdirSync(dirname(sessions))).toEqual(['sessions.desktop.main.js']);
  });

  it('does not undo either bundle if the second bundle or its backup was edited', () => {
    expect(runPatch('--apply').status).toBe(0);
    const patchedSessions = fs.readFileSync(sessions, 'utf8');
    const patchedWorkbench = fs.readFileSync(workbench, 'utf8');
    const modified = patchedWorkbench.replace('Working directory:', 'Changed:');
    fs.writeFileSync(workbench, modified);
    expect(runPatch('--unpatch')).toMatchObject({ status: 1, output: expect.stringContaining('modified patch block') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(patchedSessions);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(modified);

    fs.writeFileSync(workbench, patchedWorkbench);
    fs.writeFileSync(backupPath(workbench, workbenchOriginal), 'different build');
    expect(runPatch('--unpatch')).toMatchObject({ status: 1, output: expect.stringContaining('Backup does not match') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(patchedSessions);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(patchedWorkbench);
  });

  it('uses verified markers when a v1 backup is missing and requires a matching backup for legacy markers', () => {
    expect(runPatch('--apply').status).toBe(0);
    fs.unlinkSync(backupPath(sessions, sessionsOriginal));
    expect(runPatch('--check')).toMatchObject({ status: 1, output: expect.stringContaining('Backup missing') });
    expect(runPatch('--unpatch')).toMatchObject({ status: 0, output: expect.stringContaining('Original bytes verified') });
    expect(fs.readFileSync(sessions, 'utf8')).toBe(sessionsOriginal);

    const legacy = '/*AGY_HARNESS_PATCH_START*/void 0;/*AGY_HARNESS_PATCH_END*/original();';
    fs.writeFileSync(workbench, legacy);
    expect(runPatch('--unpatch')).toMatchObject({ status: 1, output: expect.stringContaining('Legacy patch has no matching backup') });
    expect(fs.readFileSync(workbench, 'utf8')).toBe(legacy);
    fs.writeFileSync(`${workbench}.bak`, 'original();');
    expect(runPatch('--unpatch').status).toBe(0);
    expect(fs.readFileSync(workbench, 'utf8')).toBe('original();');
  });

  it('leaves the first bundle unchanged if another writer edits the second during replacement', () => {
    const rename = fs.renameSync;
    const edited = `${workbenchOriginal}\n;void 1;`;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (to === sessions && String(from).endsWith('next.mjs')) fs.writeFileSync(workbench, edited);
    });

    expect(() => runApply(root)).toThrow('Bundle changed during the operation');
    expect(fs.readFileSync(sessions, 'utf8')).toBe(sessionsOriginal);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(edited);
  });

  it('restores the first bundle if replacing the second one fails', () => {
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === workbench) throw new Error('simulated locked Workbench bundle');
      rename(from, to);
    });
    expect(() => runApply(root)).toThrow('simulated locked Workbench bundle');
    expect(fs.readFileSync(sessions, 'utf8')).toBe(sessionsOriginal);
    expect(fs.readFileSync(workbench, 'utf8')).toBe(workbenchOriginal);
    expect(fs.readFileSync(backupPath(sessions, sessionsOriginal), 'utf8')).toBe(sessionsOriginal);
    expect(fs.readdirSync(dirname(sessions)).some((entry) => entry.startsWith('.agy-ui-'))).toBe(false);
  });

  it('registers AntigravitySessionsProvider in Agents Window with local workspace mapping, models, drafts, and mode picker menus', () => {
    expect(runPatch('--apply').status).toBe(0);
    const providers: unknown[] = [];
    const registeredViewItems = new Map<string, (...args: unknown[]) => unknown>();
    const registeredActions: unknown[] = [];
    const makeUri = (scheme: string, path: string, fsPath?: string) => ({
      scheme,
      path,
      fsPath: fsPath ?? path,
      toString: () => `${scheme}:${path}`,
      with: (next: { scheme?: string; path?: string }) => makeUri(next.scheme ?? scheme, next.path ?? path),
    });
    const uriHelper = {
      parse: (raw: string) => {
        const [scheme = 'file', path = '/'] = raw.split(':');
        return makeUri(scheme, path);
      },
      from: ({ scheme, path }: { scheme: string; path: string }) => makeUri(scheme, path),
      file: (fsPath: string) => makeUri('file', fsPath.replace(/\\/g, '/'), fsPath),
    };
    const agyItem = {
      resource: makeUri('antigravity', '/sess-1'),
      providerType: 'antigravity',
      icon: { id: 'terminal' },
      metadata: { workingDirectoryPath: 'd:\\Code Library\\agy-copilot-harness' },
      timing: { created: 100 },
    };
    const agyModels = [
      { identifier: 'antigravity:gemini-2.5-pro', metadata: { targetChatSessionType: 'antigravity', vendor: 'antigravity' } },
      { identifier: 'copilot:gpt-5', metadata: { targetChatSessionType: 'copilot', vendor: 'copilot' } },
    ];
    const modeGroup = {
      id: 'mode',
      name: 'Agent Mode',
      items: [
        { id: 'default', name: 'Default', agyPickerMeta: { provider: 'antigravity', category: 'permission', shortLabel: 'Manual' } },
        { id: 'plan', name: 'Plan', agyPickerMeta: { provider: 'antigravity', category: 'mode', shortLabel: 'Plan' } },
      ],
      selected: undefined as unknown,
    };
    modeGroup.selected = modeGroup.items[0];
    const activeSessionObs = { get: () => undefined as unknown };
    const sessionOptions = new Map<string, unknown>();
    const chatSessionsService = {
      activateChatSessionItemProvider: vi.fn(async () => {}),
      getNewChatSessionInputState: vi.fn(async () => [modeGroup]),
      getOptionGroupsForSessionType: vi.fn((type: string) => (type === 'antigravity' ? [modeGroup] : undefined)),
      getSessionOption: vi.fn((res: { toString: () => string }, key: string) =>
        sessionOptions.get(`${res.toString()}::${key}`),
      ),
      setSessionOption: vi.fn((res: { toString: () => string }, key: string, val: unknown) => {
        sessionOptions.set(`${res.toString()}::${key}`, val);
      }),
      onDidChangeItemsProviders: () => ({ dispose() {} }),
      onDidChangeOptionGroups: () => ({ dispose() {} }),
    };
    const languageModelsService = {
      getLanguageModelIds: () => agyModels.map((m) => m.identifier),
      lookupLanguageModel: (id: string) => agyModels.find((m) => m.identifier === id)?.metadata,
      selectLanguageModels: vi.fn(async () => agyModels.map((m) => m.identifier)),
      onDidChangeLanguageModels: () => ({ dispose() {} }),
    };
    const agentSessionsService = {
      model: {
        sessions: [agyItem],
        onDidChangeSessions: () => ({ dispose() {} }),
      },
    };
    const instantiationService = {
      createInstance: (Ctor: new (...args: unknown[]) => unknown, ...args: unknown[]) =>
        new Ctor(
          ...args,
          agentSessionsService,
          {},
          chatSessionsService,
          {},
          instantiationService,
          languageModelsService,
        ),
    };
    const services = {
      get: (tok: string) => {
        if (tok === 'inst') return instantiationService;
        if (tok === 'providers') return { registerProvider: (p: unknown) => providers.push(p) };
        if (tok === 'sl') return { session: activeSessionObs };
        return {};
      },
    };
    class BaseOptionPicker {
      public readonly _disposables: Array<{ dispose?: () => void }> = [];
      public constructor(
        public readonly action: unknown,
        public readonly init: { group: unknown; item: unknown },
        public readonly delegate: {
          getOptionGroup: () => unknown;
          setOption: (opt: unknown) => void;
          getSessionResource: () => { scheme?: string };
        },
      ) {}
      public _register<T extends { dispose?: () => void }>(d: T): T {
        this._disposables.push(d);
        return d;
      }
      public getDropdownActions() {
        return [];
      }
    }
    class BaseContrib {
      public _register<T>(x: T): T {
        return x;
      }
    }
    class DispStore {
      public add<T>(x: T): T {
        return x;
      }
    }
    class BaseAction2 {
      public constructor(public readonly desc: unknown) {}
    }

    const summary = runInNewContext(
      `
      ${fs.readFileSync(sessions, 'utf8')}
      dis();
      new G4e({ register: (_menu, id, fn) => __regViewItem(id, fn) }, {});
      Nos(__services);
      const agy = __providers.find((p) => p.id === 'antigravity');
      const folderUri = $URI.file('d:\\\\Code Library\\\\agy-copilot-harness');
      const resolvedWs = agy.resolveWorkspace(folderUri);
      const cachedWrapped = agy._chatToSession(agy._sessionCache.get('antigravity:/sess-1'));
      const chatPickerFactory = __getViewItem('antigravity.chatSessionModePicker');
      const chatPickerInstance = chatPickerFactory(
        { id: 'antigravity.chatSessionModePicker' },
        { actionContext: { widget: { viewModel: { model: { sessionResource: cachedWrapped.resource } } } } },
        { invokeFunction: (fn) => fn(__services), createInstance: (Ctor, ...args) => new Ctor(...args) },
      );
      chatPickerInstance.delegate.setOption(modeGroupItems[1]);
      const chatSelectedAfterPick = chatPickerInstance.delegate.getOptionGroup().selected?.id;
      const workingSetResult = new EditingWidget().renderChatEditingSessionWithEntries(
        null,
        { chatSessionResource: cachedWrapped.resource, entries: { read: () => [] } },
        { read: () => [{ reference: 'file:///live.ts' }] },
        { read: () => [{ reference: 'file:///live.ts' }, { reference: 'file:///hist.ts' }] },
      );

      const snapshot = agy.getModelsSnapshotForCreation(undefined, 'antigravity', undefined);
      const draft = agy.createNewSession(folderUri, 'antigravity', {});
      const draftUsesSandbox = agy._usesSandbox({ sessionId: draft.sessionId });
      const pickerOptions = agy.getModelPickerOptions(draft.sessionId);
      __setActiveSession(draft);
      const pickerFactory = __getViewItem('antigravity.newSessionModePicker');
      const pickerInstance = pickerFactory(
        { id: 'antigravity.newSessionModePicker' },
        {},
        { invokeFunction: (fn) => fn(__services), createInstance: (Ctor, ...args) => new Ctor(...args) },
      );
      pickerInstance.delegate.setOption(modeGroupItems[1]);
      const updatedGroup = pickerInstance.delegate.getOptionGroup();
      ({
        providerIds: __providers.map((p) => p.id),
        env: agy.environment,
        supportsLocal: agy.supportsLocalWorkspaces,
        supportsQuick: agy.supportsQuickChats,
        browseCount: agy.browseActions.length,
        resolvedWsLabel: resolvedWs?.label,
        resolvedWsTrust: resolvedWs?.requiresWorkspaceTrust,
        draftUsesSandbox,
        pickerAutoModel: pickerOptions.showAutoModel,
        snapshotModelIds: snapshot.models.map((m) => m.identifier),
        draftHarness: draft.harness,
        draftIcon: draft.icon?.id,
        selectedAfterPick: updatedGroup.selected?.id,
        chatSelectedAfterPick,
        workingSetRefs: workingSetResult.map((x) => x.reference),
        cachedLabel: cachedWrapped.workspace?.get()?.label,
        cachedVirtual: cachedWrapped.workspace?.get()?.isVirtualWorkspace,
        cachedIcon: cachedWrapped.icon?.id,
        hasAntigravityChatInputAction: __actions.some(
          (a) => a.desc?.id === 'antigravity.chatSessionModePicker' && a.desc?.menu?.some?.((m) => m.id === 'ChatInput'),
        ),
        registeredActionCount: __actions.length,
      });
      `,
      {
        token: (n: string) => n,
        __services: services,
        __providers: providers,
        __regViewItem: (id: string, fn: (...args: unknown[]) => unknown) => registeredViewItems.set(id, fn),
        __getViewItem: (id: string) => registeredViewItems.get(id),
        __actions: registeredActions,
        __setActiveSession: (s: unknown) => {
          activeSessionObs.get = () => s;
        },
        modeGroupItems: modeGroup.items,
        $InstToken: 'inst',
        $ProvidersToken: 'providers',
        $Sl: 'sl',
        $URI: uriHelper,
        $uuid: () => 'uuid-1234',
        $obs: (v: unknown) => ({ get: () => v }),
        $makeEmitter: () => ({ event: () => ({ dispose() {} }), fire: () => {} }),
        $resolveInner: (models: unknown[], desired: unknown) => ({ kind: models.length ? 'available' : 'unavailable', desired }),
        $Expr: {
          and: (...xs: unknown[]) => ({ and: xs }),
          or: (...xs: unknown[]) => ({ or: xs }),
          equals: (k: string, v: unknown) => ({ eq: [k, v] }),
        },
        $MenuId: { ChatInput: 'ChatInput', ChatInputSecondary: 'ChatInputSecondary' },
        $Wt: { NewSessionControl: 'NewSessionControl' },
        $Ctx: {
          enabled: 'enabled',
          chatSessionHasModels: 'hasModels',
          lockedToCodingAgent: 'locked',
          chatSessionType: {
            isEqualTo: (v: string) => ({ eq: v }),
            notEqualsTo: (v: string) => ({ neq: v }),
          },
        },
        $Provider: { Cloud: 'cloud', Background: 'background' },
        $IsSessions: { negate: () => ({ not: 'isSessions' }) },
        $SessionsWin: 'isSessionsWin',
        $SandboxProv: 'sandbox',
        $TiKey: { isEqualTo: (v: string) => ({ ti: v }) },
        _sqa: 'sqa',
        BaseOptionPicker,
        BaseContrib,
        DispStore,
        $Action2: BaseAction2,
        $regAction: (Cls: new () => unknown) => {
          const inst = new Cls();
          registeredActions.push(inst);
          return inst;
        },
        ViewItem: class {},
        $d: () => 'Pick',
        $ko: vi.fn(),
        $qu: vi.fn(),
        $dom: vi.fn(),
        $reset: vi.fn(),
        $markdown: () => false,
        $knownProvider: () => undefined,
        $providerIcon: () => ({}),
        $themeIcon: { asClassName: () => '' },
        $source: { External: 'ext' },
        $invocation: class {},
        $revive: (x: unknown) => x,
        $separator: class {},
        $bar: class {},
        $action: class {},
        Widget: class {},
        $append: vi.fn(),
        $element: vi.fn(),
      },
    );
    expect(summary).toEqual({
      providerIds: ['antigravity', 'default'],
      env: { id: 'local', label: 'Local' },
      supportsLocal: true,
      supportsQuick: true,
      browseCount: 0,
      resolvedWsLabel: 'ws',
      resolvedWsTrust: false,
      draftUsesSandbox: false,
      pickerAutoModel: false,
      snapshotModelIds: ['antigravity:gemini-2.5-pro'],
      draftHarness: 'antigravity',
      draftIcon: 'antigravity-logo',
      selectedAfterPick: 'plan',
      chatSelectedAfterPick: 'plan',
      workingSetRefs: ['file:///live.ts', 'file:///hist.ts'],
      cachedLabel: 'agy-copilot-harness',
      cachedVirtual: false,
      cachedIcon: 'antigravity-logo',
      hasAntigravityChatInputAction: true,
      registeredActionCount: 4,
    });
  });
});
