# Antigravity Copilot Harness — VS Code E2E Verification Checklist

Target environment: **VS Code 1.147.0** (`8a14f0cc1b`) + **Antigravity CLI (`agy.exe`)** on Windows.

---

## 1. Pre-Flight & Installation

- [ ] **Verify local `agy.exe` and Antigravity login state**
  - Confirm `C:\Users\<user>\.gemini\bin\agy.exe` (or `agy` on `PATH`) exists.
  - Confirm `C:\Users\<user>\.gemini\antigravity` has an active login and existing `conversations/*.db` files.
- [ ] **Run automated unit & lint checks**
  ```powershell
  npm run check:lint
  npm run test:unit
  ```
- [ ] **Run pre-patch anchor check**
  ```powershell
  node scripts/patch-sessions-ui.js --check
  ```
  - Expected: Detects `C:\Program Files\Microsoft VS Code\8a14f0cc1b\resources\app\out\vs` (or `%LOCALAPPDATA%\Programs\Microsoft VS Code\...`) and reports `anchors verified` for both `sessions.desktop.main.js` and `workbench.desktop.main.js`.
- [ ] **Run one-click installer (Administrator PowerShell if VS Code is under `Program Files`)**
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/install.ps1
  ```
  - Verify `node scripts/patch-argv.js --check` prints `ENABLED` and preserves all existing comments in `%USERPROFILE%\.vscode\argv.json`.
  - Verify `node scripts/patch-sessions-ui.js --check` reports `patched (v1, markers=7)` for `sessions.desktop.main.js` and `patched (v1, markers=6)` for `workbench.desktop.main.js`, with `backup=verified` for both.
  - Verify `antigravity.agy-copilot-harness` is installed (`code --list-extensions | Select-String agy-copilot-harness`).
- [ ] **Restart VS Code completely** so `argv.json` and patched UI bundles load cleanly.

---

## 2. Extension Activation & Proposed API Bootstrap

- [ ] **No fallback reload prompt when `argv.json` is configured**
  - Open VS Code (`Output` -> `Antigravity` / `Extension Host`).
  - Expected: `isProposedApiAvailable()` succeeds (`vscode.chat.createChatSessionItemController` present); no `"Reload Window"` warning toast appears.
- [ ] **Single-process ACP backend startup**
  - Confirm `agy.exe acp --app-data-dir antigravity --log-file ...` launches once, obtains the HTTP port from `Language server listening on random port at <port> for HTTP` (or uses `daemon/hub_*.json` cold-start cache), and queries `GetUserStatus` without `-32000 Authentication required` errors.

---

## 3. Account & Quota UI Alignment (3 Native Surfaces)

- [ ] **Surface 1 — Bottom-left Accounts Menu**
  - Click the VS Code Accounts icon in the bottom-left Activity Bar.
  - Expected: Entry renders as **`<email> (Google) >`** (matching GitHub / ChatGPT styling).
  - Verify `Sign Out` triggers ACP `auth/logout` and updates the signed-out state; verify `Sign in with Google` restores the session.
- [ ] **Surface 2 — Bottom-right Status Bar & Hover Card**
  - Locate the Antigravity entry next to Copilot in the bottom-right status bar.
  - Hover over the status bar entry (both in normal Workbench and Agents window).
  - Expected:
    - Shows user email, avatar (or sparkle icon), and plan tier (e.g., `Google AI Pro`).
    - Retains the detailed quota groups with progress bars, usage percentages, and reset times.
    - Action buttons (`Manage Models & Quotas`, `Open Harness Settings`, `Sign Out`) execute their commands and dismiss the hover.
- [ ] **Surface 3 — Agents Window Top-Right Unified Account Card**
  - Open the Agents window (`View: Open Agents Window` or titlebar widget) and click the top-right account avatar/icon to open `.sessions-account-titlebar-panel`.
  - Expected:
    - A native `section.sessions-account-titlebar-panel-provider-account` card for Antigravity renders directly under Copilot / ChatGPT inside `.sessions-account-titlebar-panel-identities`.
    - Shows the avatar (or Antigravity icon), email, Settings action, and plan label (`Google AI Pro`).
    - Uses compact Copilot/Codex-style rows: each model group has a small label, with cycle and reset time on the left and `% used` on the right. No progress bars appear here.
    - Hover or tab to a row with model details to see its model list.
    - No duplicate plain-text `antigravity.providerAccount` entry appears in `.sessions-account-titlebar-panel-footer`.

---

## 4. Model, Effort, and Mode Pickers

- [ ] **Model dropdown (`targetChatSessionType: "antigravity"`)**
  - Create or open an `Antigravity` chat session.
  - Open the model picker in the chat input bar.
  - Expected: Antigravity models from `configOptions` appear; hovering/inspecting models shows remaining quota percentage and reset time.
- [ ] **Effort二级 / Secondary configuration picker**
  - Switch `thought_level` / effort (`Low`, `Medium`, `High`, `Extra` where supported by the model).
  - Expected: Calls `session/set_config_option` and persists/applies on the next prompt turn.
- [ ] **Mode selector**
  - Switch between `Default`, `Accept edits`, `Auto`, and `Plan` modes (and test `/plan` slash command).
  - Expected: Permission prompts (`session/request_permission`) follow the active mode (`Default` prompts for confirmation; `Accept edits`/`Auto` approve per policy).

---

## 5. Session List & Cross-Client Sync

- [ ] **Historical sessions list (`session/list`)**
  - Check the Chat Sessions / Agents sidebar under `Antigravity`.
  - Expected: Historical sessions from `~/.gemini/antigravity/conversations/*.db` appear with proper titles, timestamps, and normalized Windows workspace paths (`d:\...`, no `/d%3A/...` encoding artifacts).
  - With the UI patch applied, the icon next to the timestamp is the Antigravity logo for both historical and new Antigravity sessions in Workbench and the Agents window; other providers' icons and session status indicators stay unchanged.
- [ ] **Keep a running Antigravity turn alive while browsing**
  - Start a multi-step turn, return to the Agents session list without pressing **Stop**, then reopen the running session.
  - Expected: The row remains in progress and the same response resumes streaming without `session/load`, `session/cancel`, or a second `session/prompt`. Press **Stop** after reopening and verify it sends one `session/cancel` for that turn.
- [ ] **Session replay (`session/load`)**
  - Click an existing multi-turn session.
  - Expected: User prompts, thinking blocks, tool cards, and responses reconstruct accurately.
- [ ] **Keep existing Antigravity sessions on Antigravity**
  - Select Antigravity in a new chat, send a prompt, then reopen the session from the list in Workbench and the Agents window.
  - Expected: No agent switcher appears below the input. Send a follow-up and verify it goes to the same Antigravity session. The model, effort, and ACP mode pickers still work.
  - Open a new chat or a session from another provider and verify its usual agent picker behavior is unchanged.
- [ ] **Continue a session in a Windows project path with spaces**
  - Open a folder such as `D:\Code Library\demo`, start an Antigravity session, refresh the list, then reopen the session and send a follow-up.
  - Expected: An ACP working directory such as `/d:/Code%20Library/demo` matches the open folder. The session remains visible and can be continued without switching windows.
- [ ] **Live cross-client sync**
  - Run or update a conversation from Antigravity Desktop / CLI in the background.
  - Expected: Watcher on `~/.gemini/antigravity/conversations/*.db` triggers a debounced refresh and updates the session list in VS Code automatically.
- [ ] **Prompt cancellation**
  - Start a long prompt and click **Stop**.
  - Expected: Sends `session/cancel`, stops streaming cleanly, and refreshes quota afterward.

---

## 6. Rich Response, Terminal, Diff & Browser Subagent Rendering

- [ ] **Thinking progress (`ChatResponseThinkingProgressPart`)**
  - Send a reasoning prompt; verify collapsible Thinking blocks stream incrementally.
- [ ] **Low-credit warning**
  - Open an Antigravity session that contains the “Your AI credits balance is too low to continue.” notice.
  - Expected: The notice uses the native VS Code chat warning style, with one warning icon, both live and when the session is reopened.
- [ ] **Terminal execution cards (`run_command`)**
  - Ask the agent to run a shell command (e.g., `node -v`).
  - Expected: Renders a native expandable terminal card showing the command line, output stream, exit code, and duration, without a redundant `Run` label between the command and its output.
- [ ] **File read links & Diff statistics (`read_file`, `edit_file`, `write_file`)**
  - Ask the agent to read and edit a file in the workspace.
  - Expected: Read tool displays clickable file link with line range; edits emit `ChatResponseTextEditPart` and update `ChatSessionItem.changes` (`+X -Y`), opening a native Diff view on click.
- [ ] **Browser Subagent (`invoke_subagent` with `TypeName: "browser"`)**
  - Trigger a browser automation task (e.g., open a web page and capture/inspect UI).
  - Expected:
    1. Top-level collapsible `Browser` subagent card appears (`isComplete` false while running, true when done).
    2. Individual browser actions (navigate, click, type, scroll) stream as nested child tool parts inside the `Browser` card via `subAgentInvocationId`.
    3. PNG/JPEG/WebP screenshots/animations from `transcript.jsonl` render inline via `type: "embed"`.
    4. If a `.webm` recording exists, clicking the `Open Browser Recording / Media` command button plays the video in the HTML5 Webview preview panel.
    5. When the browser subagent pauses on a login wall or CAPTCHA, the session status transitions to `NeedsInput` with clear manual takeover instructions.

---

## 7. Clean Unpatch & Rollback Verification

- [ ] **Unpatch VS Code UI bundles**
  ```powershell
  node scripts/patch-sessions-ui.js --unpatch
  node scripts/patch-sessions-ui.js --check
  ```
  - Expected: Both bundles match their original `.agy-harness-<sha256>.bak` files byte for byte, except for a recognized BackgroundCover footer, which is preserved. Backups are retained, and `--check` reports `unpatched, anchors verified`.
- [ ] **Remove proposed API entry (optional cleanup)**
  ```powershell
  node scripts/patch-argv.js --remove
  node scripts/patch-argv.js --check
  ```
  - Expected: Removes `antigravity.agy-copilot-harness` from `enable-proposed-api` while keeping all `argv.json` comments intact (`--check` exits 1 with `NOT ENABLED`).
