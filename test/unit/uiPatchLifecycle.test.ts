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
    'class ChatSessionsService{constructor(contributions){this._contributions=contributions}supportsDelegationForSessionType($type){return this._contributions.get($type)?.contribution?.supportsDelegation!==!1}}',
    'function external(e){let n={id:e.toolName,source:$source.External,displayName:e.toolName,modelDescription:e.toolName},r=new $invocation({invocationMessage:e.invocationMessage,pastTenseMessage:e.pastTenseMessage,toolSpecificData:e.toolSpecificData},n);return r}',
    'class Agent{answer(e){this._proxy.$handleQuestionCarouselAnswer(e)}async $handleProgressChunk(e,t){let i=this._pendingProgress.get(e);let{progress:n,chatSession:r,isSubagent:a}=i,c=[],l=r?.getRequests().find(u=>u.id===e)?.response;for(let u of t){let[p,h]=Array.isArray(u)?u:[u];if(p.kind==="externalEdits"){if(r?.editingSession&&h!==void 0&&l){let f=p.start?await r.editingSession.startExternalEdits(l,h,$revive(p.resources),p.undoStopId):await r.editingSession.stopExternalEdits(l,h);c.push(...f)}continue}if(p.kind==="beginToolInvocation"){c.push(p);continue}c.push(p)}n(c)}}',
    'class RemoteSession{async _doInitializeContent(e,t){let i=await this._proxy.$provideChatSessionContent();this.history.length=0;this.history.push(...i.history.map(c=>{if(c.type==="request")return c;return{type:"response",parts:c.parts.map(l=>$revive(l)),participant:c.participant,details:c.details}})),i.hasActiveResponseCallback&&void 0,i.hasForkHandler&&!this.forkSession&&(this.forkSession=async(c,l)=>{let u=await this._proxy.$forkChatSession(this._providerHandle,this.sessionResource,c?this.toRequestDto(c):void 0,l);return $revive(u)})}}',
    'class EditingWidget{renderChatEditingSessionWithEntries(e,t,i,n){let C=i.read(e),k=n.read(e);return C.concat(k)}}',
    'class ChatSvc{notifyUserAction(e){if(this._chatServiceTelemetry.notifyUserAction(e),this._onDidPerformUserAction.fire(e),e.action.kind==="chatEditingSessionAction"){let t=this._sessionModels.get(e.sessionResource);t&&t.notifyEditingAction(e.action)}}}',
  ].join('\r\n');
}

const sessionsOriginal = `${commonBundle()}
var $chat=token("chatStatusItemService");
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
});
