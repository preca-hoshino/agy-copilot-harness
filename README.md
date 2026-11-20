# Antigravity Copilot Harness

Integrate Google Antigravity (`agy acp`) natively into VS Code Agents / Chat Sessions, including:

- Automatic `agy.exe acp --app-data-dir antigravity` backend lifecycle management
- Native VS Code Accounts (`Google`), bottom-right quota status card, and Agents top-right account panel card
- Native model & effort picker (`targetChatSessionType: "antigravity"`)
- Discover and load sessions exposed by the configured ACP backend (`session/list`, `session/load`, `conversations/*.db` watcher). This does not register VS Code sessions in the standalone IDE's history.
- Native rendering for thinking blocks, terminal commands, file diffs, and Antigravity browser subagent steps & media

## Build, Check & Install

The **Agent Mode** picker uses Antigravity's ACP modes, not Copilot SDK permission or sandbox settings. To select a custom main agent for the backend, set `antigravityHarness.mainAgent` and reload VS Code. The setting applies at startup, not as an in-session switch.

```powershell
npm run check
npm run test:integration
npm run install:local
```
