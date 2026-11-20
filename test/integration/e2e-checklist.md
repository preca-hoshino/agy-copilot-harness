# Antigravity Copilot Harness — VS Code 1.146.0 E2E Verification Checklist

Target environment: **VS Code 1.146.0** (`69047191fc`) + **Antigravity CLI (`agy.exe`)** on Windows.

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
  - Expected: Detects `C:\Program Files\Microsoft VS Code\69047191fc\resources\app\out\vs` (or `%LOCALAPPDATA%\Programs\Microsoft VS Code\...`) and reports `anchors verified` for both `sessions.desktop.main.js` and `workbench.desktop.main.js`.
- [ ] **Run one-click installer (Administrator PowerShell if VS Code is under `Program Files`)**
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/install.ps1
  ```
  - Verify `node scripts/patch-argv.js --check` prints `ENABLED` and preserves all existing comments in `%USERPROFILE%\.vscode\argv.json`.
  - Verify `node scripts/patch-sessions-ui.js --check` prints `patched (markers=2)` for `sessions.desktop.main.js` and `patched (markers=1)` for `workbench.desktop.main.js`, with `.bak` backups present.
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
    - Renders native `div.quota-bar` > `div.quota-bit` progress bars for clustered quota pools (`5-Hour limit`, `Weekly limit`) with `XX% used` and reset countdowns.
    - Action buttons (`Manage Models & Quotas`, `Open Harness Settings`, `Sign Out`) execute their commands and dismiss the hover.
- [ ] **Surface 3 — Agents Window Top-Right Unified Account Card**
  - Open the Agents window (`View: Open Agents Window` or titlebar widget) and click the top-right account avatar/icon to open `.sessions-account-titlebar-panel`.
  - Expected:
    - A native `section.sessions-account-titlebar-panel-provider-account` card for Antigravity renders directly under Copilot / ChatGPT inside `.sessions-account-titlebar-panel-identities`.
    - Shows avatar (or sparkle icon), email, `[Manage Models]`, `[Settings]`, `[Sign Out]` icon buttons, plan label (`Google AI Pro`), and `5h` / `Weekly` metric rows with hover tooltips.
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
- [ ] **Session replay (`session/load`)**
  - Click an existing multi-turn session.
  - Expected: User prompts, thinking blocks, tool cards, and responses reconstruct accurately.
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
- [ ] **Terminal execution cards (`run_command`)**
  - Ask the agent to run a shell command (e.g., `node -v`).
  - Expected: Renders native expandable terminal invocation card showing command line, output stream, exit code, and duration.
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
  - Expected: Removes all `/*AGY_HARNESS_PATCH_START*/.../*AGY_HARNESS_PATCH_END*/` blocks, removes matching `.bak` files, and `--check` reports `unpatched (anchors verified)`.
- [ ] **Remove proposed API entry (optional cleanup)**
  ```powershell
  node scripts/patch-argv.js --remove
  node scripts/patch-argv.js --check
  ```
  - Expected: Removes `antigravity.agy-copilot-harness` from `enable-proposed-api` while keeping all `argv.json` comments intact (`--check` exits 1 with `NOT ENABLED`).
