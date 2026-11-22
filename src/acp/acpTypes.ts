export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?:
    | {
        code: number;
        message: string;
        data?: unknown;
      }
    | undefined;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | undefined;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown> | undefined;
  agentInfo?:
    | {
        name: string;
        version: string;
      }
    | undefined;
  authMethods?: AcpAuthMethod[] | undefined;
}

export interface AcpSessionSummary {
  sessionId: string;
  cwd: string;
  title?: string | undefined;
  updatedAt?: string | undefined;
}

export interface AcpSessionListResult {
  sessions: AcpSessionSummary[];
  nextCursor?: string | null | undefined;
}

export interface AcpConfigOptionChoice {
  value: string;
  name: string;
  description?: string | undefined;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string | undefined;
  type: string;
  currentValue: string;
  options: AcpConfigOptionChoice[];
}

export interface AcpAvailableModel {
  modelId: string;
  name: string;
}

export interface AcpSessionLoadResult {
  sessionId: string;
  models?:
    | {
        availableModels: AcpAvailableModel[];
        currentModelId: string;
      }
    | undefined;
  modes?:
    | {
        currentModeId: string;
        availableModes: Array<{ id: string; name: string; description?: string | undefined }>;
      }
    | undefined;
  configOptions?: AcpConfigOption[] | undefined;
  _meta?:
    | {
        antigravity?:
          | {
              tier?:
                | {
                    id: string;
                    name: string;
                    upgradeUri?: string | undefined;
                  }
                | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface AcpContentBlock {
  type: 'text' | 'image' | 'resource' | 'resource_link';
  text?: string | undefined;
  data?: string | undefined;
  mimeType?: string | undefined;
  uri?: string | undefined;
  name?: string | undefined;
  resource?:
    | {
        uri: string;
        mimeType?: string | undefined;
        text?: string | undefined;
        blob?: string | undefined;
      }
    | undefined;
}

export interface AcpToolCallLocation {
  path: string;
  line?: number | undefined;
}

export interface AcpToolCallContentDiff {
  type: 'diff';
  path: string;
  oldText?: string | undefined;
  newText?: string | undefined;
}

export interface AcpToolCallContentText {
  type: 'content';
  content: AcpContentBlock;
}

export interface AcpToolCallContentTerminal {
  type: 'terminal';
  terminalId: string;
}

export type AcpToolCallContentItem =
  | AcpToolCallContentDiff
  | AcpToolCallContentText
  | AcpToolCallContentTerminal
  | Record<string, unknown>;

export interface AcpToolCallUpdatePayload {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  name?: string | undefined;
  title?: string | undefined;
  kind?: string | undefined;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | undefined;
  args?: Record<string, unknown> | undefined;
  rawInput?: Record<string, unknown> | undefined;
  rawOutput?: Record<string, unknown> | undefined;
  locations?: AcpToolCallLocation[] | undefined;
  content?: AcpToolCallContentItem[] | undefined;
}

export interface AcpPlanUpdatePayload {
  sessionUpdate: 'plan';
  entries: Array<{
    content: string;
    priority?: string | undefined;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
}

export interface AcpMessageChunkPayload {
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
  content: AcpContentBlock;
}

export interface AcpUsageUpdatePayload {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
}

export interface AcpModeUpdatePayload {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

export interface AcpConfigOptionUpdatePayload {
  sessionUpdate: 'config_option_update';
  configOptions: AcpConfigOption[];
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  input?: {
    hint?: string;
  } | null;
}

export interface AcpAvailableCommandsUpdatePayload {
  sessionUpdate: 'available_commands_update';
  availableCommands: AcpAvailableCommand[];
}

export type AcpSessionUpdate =
  | AcpMessageChunkPayload
  | AcpToolCallUpdatePayload
  | AcpPlanUpdatePayload
  | AcpUsageUpdatePayload
  | AcpModeUpdatePayload
  | AcpConfigOptionUpdatePayload
  | AcpAvailableCommandsUpdatePayload
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpSessionUpdateNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | (string & {});
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string | undefined;
    name?: string | undefined;
    kind?: string | undefined;
    rawInput?: Record<string, unknown> | undefined;
  };
  options: AcpPermissionOption[];
}

export interface AcpSessionPromptResult {
  stopReason?: string | undefined;
  [key: string]: unknown;
}
