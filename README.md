# Antigravity Copilot Harness

Run [Google Antigravity](https://antigravity.google) (`agy acp`) natively inside VS Code Agents and Chat Sessions.

## Features

- **Backend lifecycle** — starts and supervises the `agy acp` backend automatically.
- **Account & quota** — Google sign-in, status-bar quota hover, and an account panel in the Agents window.
- **Models** — native model and effort pickers, plus Antigravity ACP agent modes.
- **Sessions** — lists and loads sessions exposed by the ACP backend (`session/list`, `session/load`) and live-syncs with `~/.gemini/antigravity/conversations`.
- **Long-running turns** — a running turn keeps going while you switch chats; reopening the session reattaches to the live response, and **Stop** interrupts it.
- **Rich rendering** — thinking blocks, terminal commands, file diffs, low-credit warnings, and browser subagent steps with media.

> [!NOTE]
> Sessions are read from the ACP backend and are not registered in the standalone Antigravity IDE history.

## Requirements

- VS Code 1.109 or later
- [Antigravity CLI](https://antigravity.google) (`agy`) on `PATH`, or set `antigravityHarness.cliPath`
- Node.js 22 or later (to build from source)
- Windows (the installer and UI patch scripts are PowerShell/Windows oriented)

## Installation

The extension relies on VS Code proposed APIs, so it is installed from source:

```powershell
git clone https://github.com/preca-hoshino/agy-copilot-harness.git
cd agy-copilot-harness
npm ci
npm run install:local
```

`install:local` builds the VSIX, installs it, enables the required proposed APIs in `argv.json`, and applies the optional [UI patch](#optional-ui-patch). Restart VS Code afterwards. Use `-SkipUiPatch` to skip the patch:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipUiPatch
```

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `antigravityHarness.cliPath` | `""` | Path to `agy` / `agy.exe`. Empty means auto-discovery. |
| `antigravityHarness.appDataDir` | `antigravity` | App data directory under `~/.gemini`. Keep the default to share login and sessions with the desktop app/IDE. |
| `antigravityHarness.mainAgent` | `""` | Custom main agent for the backend. Reload VS Code after changing. |
| `antigravityHarness.defaultMode` | `default` | Default mode for new sessions: `default`, `accept-edits`, `auto`, or `plan`. |
| `antigravityHarness.quotaRefreshIntervalSec` | `60` | Quota polling interval (minimum 15). |
| `antigravityHarness.mirrorTerminals` | `false` | Mirror backend terminal runs into integrated terminals. |
| `antigravityHarness.showStatusBarQuota` | `true` | Show the quota indicator in the status bar. |

## Optional UI patch

Some UI details cannot be changed through the extension API. The patcher edits the installed VS Code Sessions and Workbench bundles to:

- show compact quota rows for Antigravity in the Agents account panel, matching Copilot and Codex;
- use the Antigravity logo on session rows;
- hide the agent switcher after the first prompt, so follow-ups stay with Antigravity.

```powershell
node scripts\patch-sessions-ui.js --check    # read-only compatibility and status report
node scripts\patch-sessions-ui.js --apply    # back up and patch both bundles
node scripts\patch-sessions-ui.js --unpatch  # restore the original bundles
```

Add `--vscode-root "<install or out\vs path>"` to target a specific installation.

- Close all VS Code windows before patching, and restart afterwards. Under `Program Files`, use an Administrator PowerShell.
- Re-run `--check` after each VS Code update. `Anchor not found` means the bundle layout changed.
- Backups are stored next to each bundle as `*.agy-harness-<sha256>.bak` and kept after rollback. The patcher refuses to touch bundles with unrecognized edits.

## Development

```powershell
npm ci
npm run check             # format, lint, types, dependency check, unit tests
npm run test:integration  # integration tests
npm run package           # build and produce a VSIX
```

Manual verification steps are listed in [test/integration/e2e-checklist.md](./test/integration/e2e-checklist.md).

## Contributing

Issues and pull requests are welcome. Please run `npm run check` before submitting.

## License

[GPL-3.0-only](./LICENSE). If you distribute a VSIX, make the corresponding source available as the GPL requires.

"Google" and "Antigravity" names and logos belong to their owners and are not licensed by this project. Confirm redistribution rights for the logo-derived font and artwork, or replace them, before publishing a build.
