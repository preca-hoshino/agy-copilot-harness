# Antigravity Copilot Harness 工程实施与测试计划

## 一、 项目定位与核心目标

- **项目路径**：`D:\Code Library\agy-copilot-harness`
- **扩展 ID**：`antigravity.agy-copilot-harness`
- **目标**：借鉴 `kalynnka/vscode-deepseek-harness` 的 VS Code Proposed API 架构思路，将本机 Google Antigravity（`agy.exe acp`）作为一等公民智能体后端接入 **VS Code 1.146.0 原生智能体面板（Agents Window / Chat Sessions）**，在以下维度与内置的 Codex / Claude Code 后端保持 1:1 一致体验，并对用户保持尽可能透明（零繁琐配置）：
  1. **自动管理 Antigravity 后端**：自动发现本机 CLI、按需启动并守护单进程后端、断线自愈。
  2. **3 处原生账户与配额 UI 对齐**：
     - 左下角 VS Code 集成账户管理菜单显示为 **`<email> (Google) >`**；
     - 右下角状态栏图标 + 悬停弹出的账户与配额进度条卡片（5-Hour / Weekly 配额池与重置时间）；
     - Agents 窗口右上角统一账户面板中的原生 Provider 卡片。
  3. **可用模型与思考强度选择**：在智能体输入框原生渲染 Antigravity 全量模型及 Effort 二级选项、Mode 切换（`Default / Accept edits / Auto / Plan`），Tooltip 实时显示剩余配额。
  4. **跨端双向会话同步**：直接共享 `~/.gemini/antigravity` 登录态与 `conversations/*.db`，支持历史回放与文件变更实时刷新。
  5. **完整富媒体交互渲染**：对话流、思考折叠块（Thinking）、工具调用卡片、终端命令与输出、文件 Diff、任务清单，以及 **Antigravity 原生浏览器控制（Browser Subagent）** 的嵌套动作步骤、截图/WebP 动图内嵌预览与 WebM 录屏回放。

---

## 二、 本机实测与源码逆向关键结论（Ground-Truth 依据）

以下均基于本机环境（**VS Code 1.146.0** `69047191fc` 与 **Antigravity CLI `agy.exe` v1.5.12**）实测与源码分析确认：

### 1. 单进程后端机制（ACP + 内置 `LanguageServerService`）

- **启动命令**：
  ```text
  C:\Users\<user>\.gemini\bin\agy.exe acp --app-data-dir antigravity --log-file <logPath>
  ```
  同时向子进程环境变量注入 `ANTIGRAVITY_SERVER_CSRF_TOKEN=<uuid>`。
- **共享登录态与会话库**：加上 `--app-data-dir antigravity` 后，`agy.exe acp` 直接复用 `C:\Users\<user>\.gemini\antigravity` 下的系统 Keyring OAuth 凭据与 `conversations/*.db`，实测调用 `session/list` 与 `session/load` 可直接枚举并回放桌面端与 CLI 的全部历史会话。
- **单进程拉起额度服务**：
  - `initialize` 在约 1ms 内完成握手，但 `LanguageServerService` 采用懒加载：收到首个 `session/*` 请求（如 `session/list`）时才会触发 `boot.go:65] Booting backend`，在**同一进程内**启动内置 HTTP 服务，并在 `--log-file` 指定日志中打印：
    `Language server listening on random port at <port> for HTTP`
  - 随后向 `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus` 发送 POST（携带请求头 `Content-Type: application/json`、`Connect-Protocol-Version: 1`、`x-codeium-csrf-token: <uuid>`，Body 为 `{"metadata":{}}`），即可获取：
    - 用户账号与套餐信息（如 `Google AI Pro` / `g1-pro-tier`、`availablePromptCredits` / `monthlyPromptCredits`、`availableFlowCredits` / `monthlyFlowCredits`）；
    - 全部 24 个模型的 `cascadeModelConfigData.clientModelConfigs[].quotaInfo`（包含 `remainingFraction` 与 `resetTime`）。
- **冷启动快取与鉴权竞态规避**：
  - 首次 `boot.go` 加载 Keyring 凭证与 `loadCodeAssist` 约耗时 1.5~3 秒；若在启动完成前关闭 stdio 或并发抢跑会返回 `-32000 Authentication required`。客户端必须维护长连接 stdio 队列并实现启动期鉴权等待与自动重试。
  - 在 `boot.go` 尚未完成日志吐出端口前的冷启动窗口内，可扫描 `C:\Users\<user>\.gemini\antigravity\daemon\hub_*.json`，若存在存活 PID 的 Hub 进程，立即借用其 `httpPort` 与 `csrfToken` 秒级读取额度，实现 0 延迟首屏展示。

### 2. VS Code 1.146.0 (`69047191fc`) 内部 API 精确映射

通过分析本机 `resources/app/out/vs/workbench/api/node/extensionHostProcess.js`、`extensions/copilot/dist/extension.js`、`workbench.desktop.main.js` 与 `sessions.desktop.main.js`，确认如下契约：

- **会话列表与内容（`chatSessionsProvider`）**：
  - `vscode.chat.createChatSessionItemController('antigravity', refreshHandler)`（替代已弃用的 `registerChatSessionItemProvider`）；
  - `vscode.chat.registerChatSessionContentProvider('antigravity', contentProvider, participant, capabilities)`。
- **模型与 Effort 二级选择器（`languageModelCapabilities` + `chatProvider`）**：
  - 通过 `vscode.lm.registerLanguageModelChatProvider('antigravity', lmProvider)` 注册模型，为每个模型设置 `targetChatSessionType: "antigravity"` 与 `configurationSchema.properties.effortLevel`，即可在智能体面板输入框原生出现模型列表及思考强度下拉框。
- **Chat Parts 序列化规则（源自 `extensionHostProcess.js` 中 `m9` 转换器，`idx: 1116557`）**：
  - **增量更新**：`ChatToolInvocationPart.enablePartialUpdate = true` -> `{ kind: "externalToolInvocationUpdate" }`，支持工具或浏览器任务运行过程中实时更新进度文本与完成状态。
  - **终端命令卡片**：`toolSpecificData: { commandLine: { original }, language, output: { text }, state: { exitCode, duration } }` -> 序列化为 `{ kind: "terminal", commandLine, language, terminalCommandOutput, terminalCommandState }`，渲染为原生可展开输出的终端命令卡片。
  - **子智能体折叠容器**：`toolSpecificData: new vscode.ChatSubagentToolInvocationData(description, agentName, prompt, result)` -> 序列化为 `{ kind: "subagent", description, agentName, prompt, result, modelName }`；子步骤设置 `part.subAgentInvocationId = parentToolCallId` 和 `part.subAgentName = "Browser"` 后自动嵌套进父卡片。
  - **原生内嵌图片/动图**：`toolSpecificData: { input: string, output: [{ mimeType: "image/png" | "image/jpeg" | "image/webp", data: Uint8Array }] }` -> 序列化为 `resultDetails: { input, output: [{ type: "embed", mimeType, value: base64, isText: false }] }`，直接在工具卡片内嵌渲染图片或 WebP 动图。
  - **任务清单**：`toolSpecificData: { todoList: [{ id, title, status }] }` -> `{ kind: "todoList" }`。
  - **思考过程**：`new vscode.ChatResponseThinkingProgressPart(text)` 渲染原生可折叠 Thinking 块。
- **账户与状态栏底层机制**：
  - **左下角账户菜单**：`workbench.desktop.main.js` 中 `AccountsActivityActionViewItem` 自动遍历 `authenticationService` 已注册的 Provider，按 `${account.label} (${provider.label})` 渲染，并提供原生 `退出登录` 与扩展管理菜单。
  - **右下角状态栏悬浮卡片**：`workbench.desktop.main.js` 中的 `codex.statusBarEntry`（`YHe`）与 `Vat` 使用 `div.chat-status-bar-entry-tooltip.codex-status-bar-entry-tooltip` + `div.quota-bar` 展示邮箱、套餐名、设置按钮与 `XX% used` 进度条。
  - **Agents 窗口顶栏账户面板**：`sessions.desktop.main.js` 中的 `Wei.createCombinedPanelContent`（`.sessions-account-titlebar-panel-identities`）目前在源码中仅硬编码渲染 Copilot 与 ChatGPT 两个 `section.sessions-account-titlebar-panel-provider-account`，而底部 `section.sessions-account-titlebar-panel-footer` 动态遍历 `chatStatusItemService`（即 `vscode.window.createChatStatusItem`）。

---

## 三、 专项设计 1：Antigravity 原生浏览器控制（Browser Subagent）在会话中的完整显示方案

### 1. Antigravity 浏览器控制的底层落盘机制
当 Antigravity 主智能体执行网页自动化时，会调用 `invoke_subagent`（`TypeName: "browser"`, `Role`, `Prompt`），由内置 `browser` 子智能体通过 Chrome DevTools 驱动浏览器，并实时产生两类本地数据：
- **子智能体轨迹**：`~/.gemini/antigravity/brain/<subagentConversationId>/.system_generated/logs/transcript.jsonl`（记录每一步操作文本、工具调用及附加媒体数组 `media: [{ mime_type, uri }]`）。
- **媒体资产**：`~/.gemini/antigravity/brain/<sessionId>/` 下的 `.png` / `.webp` 截图与动态录制文件，以及由 `~/.gemini/antigravity/bin/webm_encoder.exe` 生成的 `.webm` 视频文件。

### 2. VS Code 会话面板中的 4 层原生渲染架构（`src/sessions/browserSubagentRenderer.ts`）

1. **顶层 Browser Subagent 容器卡片**
   - 拦截 `name === "invoke_subagent"` 且 `args.TypeName === "browser"` 的 `tool_call`。
   - 创建 `ChatToolInvocationPart("browser", toolCallId)`，挂载：
     ```ts
     part.toolSpecificData = new vscode.ChatSubagentToolInvocationData(
       args.Role || "Browser Automation",
       "Browser",
       args.Prompt,
       finalResult
     );
     part.enablePartialUpdate = true;
     ```
   - 在执行期间保持 `isComplete = false`，结束后回填 `result` 并置 `isComplete = true`。

2. **子步骤实时流式嵌套（`subAgentInvocationId`）**
   - `BrowserTrajectoryWatcher` 在 `invoke_subagent` (`browser`) 启动后实时跟踪对应子智能体的 `transcript.jsonl`（结合 ACP 流中的子工具事件与父会话关联），将每一步浏览器动作（打开 URL、点击、输入、滚动、等待、DOM 检查）映射为子 `ChatToolInvocationPart`：
     ```ts
     childPart.subAgentInvocationId = parentBrowserToolCallId;
     childPart.subAgentName = "Browser";
     ```
   - VS Code UI 自动把所有浏览器操作步骤收纳在顶层 `Browser` 子智能体折叠卡片内，与 Codex / Claude Code 的 Subagent 展示结构一致；历史会话 `session/load` 回放时同样按此关联关系还原。

3. **截图与 WebP 动图原生内嵌显示（`type: "embed"`）**
   - 当浏览器步骤或 `transcript.jsonl` 的 `media` 字段出现 `image/png`、`image/jpeg`、`image/webp` 文件时，读取文件字节为 `Uint8Array`，填入子工具卡片的：
     ```ts
     childPart.toolSpecificData = {
       input: actionSummary,
       output: [{ mimeType, data: uint8Array }]
     };
     ```
   - 利用 `extensionHostProcess.js` 中 `m9` 的 `type: "embed"` 序列化通道，无需弹出外部窗口即可在会话工具卡片内直接呈现实时画面与 WebP 动图；同时在最终回答中附带对应本地图片 Markdown 链接以便查阅。

4. **WebM 录屏播放与人工接管（CAPTCHA / 登录暂停）交互**
   - 若检测到 `.webm` 录屏产物，在工具结果下方追加 `ChatResponseCommandButtonPart` 或命令链接 `[$(device-camera-video) 在 VS Code 中播放浏览器操作录屏](command:antigravityHarness.openMediaPreview?...)`，点击后使用轻量 HTML5 `<video controls>` Webview 面板播放。
   - 若 `browser` 子智能体因登录态缺失或人机验证（CAPTCHA）暂停并请求用户接管，立即将当前会话状态更新为 `vscode.ChatSessionStatus.NeedsInput`，并在对话流输出醒目提示，引导用户在 Chrome 窗口完成操作后点击“继续”。

---

## 四、 专项设计 2：3 处账户管理与配额 UI（1:1 复刻截图效果）

### 1. 位置 ①：左下角 VS Code 集成账户管理菜单（显示为 `user@example.com (Google) >`）
- **实现模块**：`src/auth/googleAuthenticationProvider.ts`
- **注册方式**：
  ```ts
  vscode.authentication.registerAuthenticationProvider(
    'google-antigravity',
    'Google',
    provider,
    { supportsMultipleAccounts: false }
  );
  ```
- **交互与同步**：
  - 将 Provider 显示名严格设为 `"Google"`，VS Code 原生账户菜单会自动渲染为 **`<email> (Google) >`**，与 `GitHub`、`Microsoft`、`ChatGPT` 保持一致；
  - 账户数据与 `AgyQuotaService` 获取的 `GetUserStatus` 实时联动，状态变化时触发 `onDidChangeSessions`；
  - 点击子菜单“退出登录”时调用 ACP `auth/logout`；未登录时点击登录入口自动在终端运行 `agy.exe acp --login --app-data-dir antigravity` 完成 OAuth 认证并刷新状态。

### 2. 位置 ②：右下角状态栏配额进度条与悬停卡片
- **实现模块**：`src/quota/quotaStatusUI.ts`
- **配额池智能聚类算法**：
  将 `GetUserStatus` 返回的 24 个模型的 `quotaInfo` 按 `(resetTime, remainingFraction)` 自动聚类为核心配额池（与 Codex 的 `5-Hour limit` / `Weekly limit` 逻辑一致）：
  - **5-Hour limit**：聚合短周期重置模型（如 `Gemini 4 Neon`、`Gemini 4 Hydrogen`、`Gemini 3.8 Flash`），计算 `usedPercent = Math.round((1 - remainingFraction) * 100)`，格式化重置时间（如 `Resets 11月19日 at 16:39`）；
  - **Weekly limit**：聚合周周期重置模型（如 `Gemini 4 Argon`、`Orchestrator (Argon)`、`Claude Opus/Sonnet 5.5`、`GPT-OSS 120B`），展示已用百分比、重置时间与横向进度条；
  - 若后台未来拆分出更多配额池，按相同 `(resetTime, remainingFraction)` 自动动态分组，不写死模型列表。
- **双模式渲染**：
  - **纯扩展模式（零文件修改）**：在 `chat.statusBarEntry` 旁注册状态栏项（`StatusBarAlignment.Right, priority: 100.05`），使用受信任 `MarkdownString` 内联动态高分 SVG Data-URI 卡片与交互命令链接，完整呈现头像、邮箱、`Google AI Pro`、设置齿轮及各配额池进度条；
  - **原生 DOM 模式（配合可选 UI 补丁）**：直接复用 VS Code 内置 `div.chat-status-bar-entry-tooltip.codex-status-bar-entry-tooltip` + `div.quota-bar` 类，达到像素级统一。

### 3. 位置 ③：Agents 窗口右上角统一账户与额度面板（`div.sessions-account-titlebar-panel`）
- **实现模块**：`src/quota/quotaStatusUI.ts` + `scripts/patch-sessions-ui.js`
- **双层融合方案**：
  - **基础层（纯 Proposed API，无侵入）**：通过 `vscode.window.createChatStatusItem('antigravity.providerAccount')` 向 `chatStatusItemService` 推送结构化账户与配额摘要，保证未打补丁时也能在弹窗底部与主窗口 Copilot 面板看到额度信息。
  - **原生顶栏卡片层（可选一键补丁，集成于 `scripts/install.ps1`）**：`scripts/patch-sessions-ui.js` 对 `sessions.desktop.main.js` 的 `Wei.createCombinedPanelContent` 与 `workbench.desktop.main.js` 做带 `.bak` 自动备份与幂等校验的轻量挂载（支持 `--unpatch` 还原）：
    - 当 `chatStatusItemService` 中存在 `antigravity.providerAccount` 时，在 `.sessions-account-titlebar-panel-identities`（`Copilot` 与 `ChatGPT` 卡片正下方、`Badges` 上方）渲染第 3 张同级原生卡片 `section.sessions-account-titlebar-panel-provider-account`；
    - 卡片内包含头像、`user@example.com`、右侧 `[$(sparkle) 管理模型] [$(gear) 设置] [$(sign-out) 退出登录]` 图标按钮、`Google AI Pro` 套餐标签，以及 `5h limit` / `Weekly limit` 配额使用率与重置倒计时，并在底部自动隐藏该条目的重复普通文本展示。

---

## 五、 专项设计 3：会话同步、模型选择、对话/工具/终端/Diff 与透明引导

### 1. 后端与传输层（`src/acp/`）
- **`jsonRpcTransport.ts`**：基于 stdio 的 NDJSON 双向 JSON-RPC 2.0 传输层，支持客户端请求-响应、服务端通知（`session/update`），以及服务端反向请求（`fs/*`、`terminal/*`、`session/request_permission`）。
- **`agyBackendManager.ts`**：
  - 自动探测 `agy.exe`（优先级：用户配置 `antigravityHarness.cliPath` -> `~/.gemini/bin/agy.exe` -> `PATH`）；
  - 启动并维持单个持久化 `agy.exe acp --app-data-dir antigravity --log-file ...` 子进程，注入 `ANTIGRAVITY_SERVER_CSRF_TOKEN`；
  - 监听日志文件捕获随机 HTTP 端口；处理首次 `boot.go` 启动期的串行鉴权队列与退避重试；子进程异常退出时按 1s / 2s / 5s 指数退避重启并自动 `session/resume`。
- **`clientCapabilitiesHandler.ts`**：
  - `fs/read_text_file`：优先读取 `vscode.workspace.textDocuments` 内存中未保存的脏缓冲区，未打开时走 `vscode.workspace.fs`；
  - `fs/write_text_file`：写入磁盘并同步刷新/应用编辑，保持编辑器视图一致；
  - `terminal/create | output | wait_for_exit | kill | release`：由 `AgyTerminalManager` 管理后台子进程输出与退出码，支持可选镜像到 VS Code 集成终端 Pseudoterminal 供用户直接查看；
  - `session/request_permission`：按当前会话 Mode（`Default / Accept edits / Auto / Plan`）决定自动放行或弹出原生确认交互。

### 2. 模型与会话同步（`src/models/` & `src/sessions/`）
- **`agyLanguageModelProvider.ts`**：实现 `LanguageModelChatProvider`，将 `agy acp` 的 `configOptions`（`model` + `thought_level`）与 `GetUserStatus` 实时配额合并，注册 `targetChatSessionType: "antigravity"`，支持按模型切换 `Low / Medium / High / Extra` 思考强度，Tooltip 实时显示剩余配额百分比与重置时间。
- **`agySessionController.ts`**：实现 `createChatSessionItemController`，调用 `session/list` 同步历史会话，处理 Windows 路径解码（如 `/d%3A/...` 转 `d:\...`），并通过监听 `~/.gemini/antigravity/conversations/*.db`（500ms 防抖）实现与桌面端/CLI 的跨端实时同步。
- **`agySessionContentProvider.ts` & `agyChatParticipant.ts`**：
  - 实现 `provideChatSessionContent`（调用 `session/load` 回放历史）与 `provideHandleOptionsChange`（调用 `session/set_config_option` 实时切换模型、Effort 与 Mode）；
  - 解析输入框 `#file`、`#selection` 与图片附件转为 ACP `prompt` 内容块；支持取消按钮联动 `session/cancel`；每轮完成后刷新 `AgyQuotaService`。
- **`turnConverter.ts`**：将历史与实时 `session/update` 统一映射为原生 Chat Parts：
  - `user_message_chunk` -> `ChatRequestTurn2`
  - `agent_thought_chunk` -> `ChatResponseThinkingProgressPart`
  - `agent_message_chunk` -> `ChatResponseMarkdownPart`
  - `tool_call` (`run_command`) -> `ChatToolInvocationPart` (`terminal` `toolSpecificData`，展示命令、摘要、输出与退出码)
  - `tool_call` (`read_file` / `view`) -> `ChatToolInvocationPart`（带行号跳转的 Markdown 文件链接）
  - `tool_call` (`edit_file` / `write_file`) -> `ChatToolInvocationPart` + `ChatResponseTextEditPart` + 更新 `ChatSessionItem.changes`（显示 `+X -Y` 修改统计并支持点击打开 Diff）
  - `tool_call` (`invoke_subagent` with `TypeName: "browser"`) -> 交由 `browserSubagentRenderer.ts` 渲染 4 层嵌套卡片与内嵌媒体

### 3. 透明部署与自愈引导（`src/bootstrap/` & `scripts/`）
- **`scripts/patch-argv.js`**：JSONC 安全无损修补工具（保留原有注释与格式），幂等写入 `"enable-proposed-api": ["antigravity.agy-copilot-harness"]` 到 `C:\Users\<user>\.vscode\argv.json`。
- **`scripts/install.ps1`**：一键执行编译 -> VSIX 打包 -> 修补 `argv.json` -> （可选）执行 `patch-sessions-ui.js` -> 安装扩展到 VS Code，全流程对用户透明。
- **`src/bootstrap/argvPatcher.ts`**：扩展激活时自检 Proposed API 是否生效；若用户手动装 VSIX 导致未写入 `argv.json`，自动修补并仅弹出一次“点击重启 VS Code 即可启用”提示。

---

## 六、 完整工程目录结构

```text
D:\Code Library\agy-copilot-harness\
├── PLAN.md
├── package.json                          # 扩展清单 (chatSessions, chatParticipants, authentication, enabledApiProposals)
├── tsconfig.json                         # TypeScript 配置
├── esbuild.config.mjs                    # 快速构建打包脚本
├── vscode.proposed.d.ts                  # 从本机 VS Code 1.146.0 精确对齐的 Proposed API 类型声明
├── scripts/
│   ├── install.ps1                       # 一键构建、修补 argv.json、UI 挂载与安装 VSIX
│   ├── patch-argv.js                     # JSONC 无损修补 ~/.vscode/argv.json
│   └── patch-sessions-ui.js              # Agents 顶栏/状态栏原生卡片轻量挂载与 --unpatch 还原
├── src/
│   ├── extension.ts                      # 激活入口：环境自检、启动 BackendManager、注册各 Provider 与命令
│   ├── bootstrap/
│   │   └── argvPatcher.ts                # Proposed API 可用性检测与自动修补自愈
│   ├── auth/
│   │   └── googleAuthenticationProvider.ts # 注册 'Google' 认证提供商，接入 VS Code 左下角账户菜单
│   ├── acp/
│   │   ├── acpTypes.ts                   # ACP v1 协议完整类型定义
│   │   ├── jsonRpcTransport.ts           # stdio NDJSON 双向 JSON-RPC 2.0 传输层
│   │   ├── agyBackendManager.ts          # agy.exe 探测、单进程守护、CSRF 注入、端口解析与鉴权队列
│   │   └── clientCapabilitiesHandler.ts  # 响应 fs/*、terminal/* 与 session/request_permission
│   ├── quota/
│   │   ├── agyQuotaService.ts            # GetUserStatus 查询、daemon/hub_*.json 快取与配额池聚类
│   │   └── quotaStatusUI.ts              # 驱动右下角状态栏卡片、ChatStatusItem、顶栏账户数据与 QuickPick
│   ├── models/
│   │   └── agyLanguageModelProvider.ts   # 注册 targetChatSessionType="antigravity" 模型与 Effort 二级选项
│   └── sessions/
│       ├── agySessionController.ts       # ChatSessionItemController、列表刷新、conversations/*.db 监听同步
│       ├── agySessionContentProvider.ts  # provideChatSessionContent、provideHandleOptionsChange
│       ├── agyChatParticipant.ts         # 实时对话、附件解析、configOptions 同步、中断控制
│       ├── browserSubagentRenderer.ts    # 原生浏览器控制 4 层嵌套卡片、截图/WebP 内嵌与 WebM 播放
│       └── turnConverter.ts              # ACP session/update -> 原生 ChatRequestTurn2 / ChatResponseTurn2
└── test/
    ├── unit/
    │   ├── jsonRpcTransport.test.ts      # NDJSON 粘包/分包、双向 RPC 与超时测试
    │   ├── quotaClustering.test.ts       # GetUserStatus 24 模型聚类为 5h / Weekly 配额池测试
    │   ├── turnConverter.test.ts         # 思考块、终端卡片、文件链接、Diff 与浏览器子智能体转换测试
    │   └── argvPatcher.test.ts           # 带注释 argv.json 无损修补测试
    └── integration/
        ├── liveAcpBackend.test.ts        # 拉起本机真实 agy.exe acp 跑通全链路集成测试
        └── e2e-checklist.md              # VS Code Extension Host 与 UI 实机验收清单
```

---

## 七、 编写到测试的全流程实施步骤（6 个阶段）

### 阶段 1：工程脚手架与本机 VS Code 1.146.0 Proposed API 类型对齐
1. 初始化 `D:\Code Library\agy-copilot-harness` 下的 `package.json`、`tsconfig.json`、`esbuild.config.mjs`。
2. 依据本机 `extensionHostProcess.js` 与 Copilot 扩展清单，编写完整的 `vscode.proposed.d.ts`（涵盖 `chatSessionsProvider`、`chatParticipantAdditions`、`languageModelCapabilities`、`chatStatusItem`）。
3. 配置 `enabledApiProposals` 与 `contributes.chatSessions`（`type: "antigravity"`）。

### 阶段 2：ACP 单进程后端、Google 账户提供商与配额服务开发
1. 实现 `JsonRpcTransport` 与 `AgyBackendManager`，打通 `agy.exe acp --app-data-dir antigravity --log-file ...` 持久化连接、CSRF 注入与启动期鉴权等待队列。
2. 实现 `ClientCapabilitiesHandler`（支持内存脏缓冲区读取、文件写入、`AgyTerminalManager` 后台终端执行与权限拦截）。
3. 实现 `AgyQuotaService`（`GetUserStatus` + `daemon/hub_*.json` 快取 + 配额池自动聚类算法）。
4. 实现 `GoogleAuthenticationProvider`（注册为 `'Google'`，对接左下角账户菜单的登录、显示与登出）。
5. 实现 `QuotaStatusUI`（状态栏 `chat.statusBarEntry` 旁配额卡片、`ChatStatusItem`、QuickPick 模型配额面板）。

### 阶段 3：可用模型选择器与原生智能体会话同步开发
1. 实现 `AgyLanguageModelProvider`，注册 `targetChatSessionType: "antigravity"` 模型、Effort 二级选项与配额 Tooltip。
2. 实现 `AgySessionController`（对接 `session/list`、Windows 路径规范化、`~/.gemini/antigravity/conversations` 文件监听跨端同步）。
3. 实现 `TurnConverter` 与 `BrowserSubagentRenderer`，完成思考块、终端卡片、文件读写链接、Diff 与浏览器子智能体嵌套步骤/内嵌媒体的历史回放转换。

### 阶段 4：实时对话、浏览器实时轨迹跟踪与中断控制
1. 实现 `AgySessionContentProvider` 与 `AgyChatParticipant`：处理 `#file` / `#selection` / 图片附件、对话前同步 `session/set_config_option`（模型 / Effort / Mode）、流式渲染 `session/update`、停止按钮触发 `session/cancel`。
2. 对接 `BrowserTrajectoryWatcher`，在 `browser` 子智能体执行期间实时跟踪其 `transcript.jsonl` 与媒体输出，流式更新子工具卡片、内嵌截图/WebP 动图，以及 `NeedsInput` 人工接管状态。
3. 回合结束后自动刷新 `AgyQuotaService`。

### 阶段 5：透明部署脚本、UI 挂载补丁与 VSIX 打包
1. 编写 `scripts/patch-argv.js`（JSONC 无损修补 `enable-proposed-api`）。
2. 编写 `scripts/patch-sessions-ui.js`（支持 `--apply` 与 `--unpatch`，带 `.bak` 备份，在 Agents 顶栏面板与状态栏卡片注入原生 Antigravity / Google AI Pro 卡片）。
3. 编写 `scripts/install.ps1` 一键完成编译、打包 `.vsix`、修补与安装；并在扩展内实现 `argvPatcher.ts` 运行时自检兜底。

### 阶段 6：自动化测试与 VS Code 实机验收
1. **单元测试（Vitest / Mocha）**：
   - `jsonRpcTransport.test.ts`：流式粘包/分包、双向 RPC 超时与错误处理；
   - `quotaClustering.test.ts`：用实测 24 模型 `GetUserStatus` 响应验证 5h / Weekly 配额池聚类与百分比计算；
   - `turnConverter.test.ts`：覆盖思考块、`run_command` 终端卡片、`read_file` 行号跳转、`write_file` Diff 与 `browser` 子智能体（嵌套步骤 + `type: "embed"` 图片数据 + WebM 按钮）；
   - `argvPatcher.test.ts`：带注释 JSONC 文件幂等读写。
2. **本机真实后端集成测试（`liveAcpBackend.test.ts`）**：
   - 直接拉起 `C:\Users\<user>\.gemini\bin\agy.exe acp --app-data-dir antigravity`，自动验证：
     - `initialize` 握手；
     - `session/list` 获取本机历史会话；
     - 日志端口提取 + `GetUserStatus` 获取真实套餐与配额；
     - `session/load` 回放真实历史会话并断言转换出的原生 Turn / Tool / Thinking 结构；
     - `session/new` + `session/set_config_option` + `session/prompt` 实时流式问答与取消。
3. **VS Code Extension Host 与实机验收（`e2e-checklist.md`）**：
   - 运行 `install.ps1` 安装到本机 VS Code 1.146.0；
   - 验证左下角 `user@example.com (Google) >`、右下角状态栏悬浮配额卡片、Agents 窗口右上角账户卡片、智能体会话列表同步、模型/Effort/Mode 切换，以及终端/文件 Diff/浏览器子智能体截图展示。
