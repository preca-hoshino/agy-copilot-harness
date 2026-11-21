// Proposed VS Code 1.146.0 API declarations verified against extensionHostProcess.js

declare module 'vscode' {
  export enum ChatQuestionType {
    SingleSelect = 2
  }

  export interface ChatQuestion {
    id: string;
    type: ChatQuestionType;
    title: string;
    message?: string | MarkdownString;
    options?: Array<{ id: string; label: string; value: unknown }>;
    defaultValue?: string | string[];
  }

  export interface ChatResponseStream {
    push(part: ChatResponsePart | ChatResponseWarningPart): void;
    questionCarousel(questions: ChatQuestion[], allowSkip?: boolean): Thenable<Record<string, unknown> | undefined>;
    externalEdit(uri: Uri | readonly Uri[], callback: () => Thenable<void>): Thenable<string>;
  }

  export enum ChatSessionStatus {
    Failed = 0,
    Completed = 1,
    InProgress = 2,
    NeedsInput = 3
  }

  export interface ChatSessionItem {
    readonly resource: Uri;
    label: string;
    iconPath?: ThemeIcon | Uri | { light: Uri; dark: Uri };
    description?: string | MarkdownString;
    badge?: string | MarkdownString;
    status?: ChatSessionStatus;
    archived?: boolean;
    tooltip?: string | MarkdownString;
    timing?: {
      created?: number;
      lastRequestStarted?: number;
      lastRequestEnded?: number;
      startTime?: number;
      endTime?: number;
    };
    changes?: ChatSessionFileChange[];
    metadata?: Record<string, unknown>;
  }

  export interface ChatSessionFileChange {
    readonly uri: Uri;
    readonly modifiedUri: Uri;
    readonly originalUri?: Uri;
    readonly insertions: number;
    readonly deletions: number;
  }

  export interface ChatSessionProviderOptionItem {
    id: string;
    name: string;
    description?: string;
    icon?: ThemeIcon;
    locked?: boolean;
    default?: boolean;
  }

  export interface ChatSessionProviderOptionGroup {
    id: string;
    name: string;
    description?: string;
    items: ChatSessionProviderOptionItem[];
    selected?: ChatSessionProviderOptionItem;
    when?: string;
    icon?: ThemeIcon;
    commands?: Command[];
    kind?: string;
  }

  export interface ChatSessionInputState {
    groups: ChatSessionProviderOptionGroup[];
    readonly onDidChange: Event<void>;
    readonly onDidDispose: Event<void>;
    sessionResource?: Uri;
    untitledSessionResource?: Uri;
  }

  export interface NewChatSessionItemContext {
    readonly request: ChatRequest;
    readonly sessionOptions?: ReadonlyArray<{ optionId: string; value: string | ChatSessionProviderOptionItem }>;
  }

  export interface ChatSessionItemCollection extends Iterable<[Uri, ChatSessionItem]> {
    readonly size: number;
    replace(items: readonly ChatSessionItem[]): void;
    add(item: ChatSessionItem): void;
    delete(resource: Uri): void;
    get(resource: Uri): ChatSessionItem | undefined;
    forEach(callbackfn: (value: ChatSessionItem, resource: Uri) => void, thisArg?: unknown): void;
  }

  export interface ChatSessionItemController extends Disposable {
    readonly id: string;
    readonly items: ChatSessionItemCollection;
    readonly onDidChangeChatSessionItemState: Event<ChatSessionItem>;
    createChatSessionItem(resource: Uri, label: string): ChatSessionItem;
    createChatSessionInputState(groups: ChatSessionProviderOptionGroup[]): ChatSessionInputState;
    newChatSessionItemHandler?: (
      context: NewChatSessionItemContext,
      token: CancellationToken
    ) => ChatSessionItem | Thenable<ChatSessionItem>;
    resolveChatSessionItem?: (
      item: ChatSessionItem,
      token: CancellationToken
    ) => ChatSessionItem | undefined | Thenable<ChatSessionItem | undefined>;
    forkHandler?: (
      sessionResource: Uri,
      request: ChatRequestTurn | undefined,
      token: CancellationToken
    ) => ChatSessionItem | Thenable<ChatSessionItem>;
    getChatSessionInputState?: (
      sessionResource: Uri | undefined,
      context: { previousInputState?: ChatSessionInputState | undefined } | undefined,
      token: CancellationToken
    ) => ChatSessionInputState | undefined | Thenable<ChatSessionInputState | undefined>;
  }

  export interface ChatSessionContentContext {
    readonly inputState: ChatSessionInputState;
  }

  export interface ChatSession {
    title?: string;
    history: Array<ChatRequestTurn | ChatResponseTurn>;
    options?: Record<string, string | ChatSessionProviderOptionItem>;
    requestHandler?: ChatRequestHandler;
    activeResponseCallback?: (stream: ChatResponseStream, token: CancellationToken) => Thenable<void> | void;
    forkHandler?: (
      sessionResource: Uri,
      request: ChatRequestTurn | undefined,
      token: CancellationToken
    ) => ChatSessionItem | Thenable<ChatSessionItem>;
  }

  export interface ChatSessionOptionUpdate {
    optionId: string;
    value: string | ChatSessionProviderOptionItem | undefined;
  }

  export interface ChatSessionContentProvider {
    readonly onDidChangeChatSessionOptions?: Event<{
      resource: Uri;
      updates: readonly ChatSessionOptionUpdate[];
    }>;
    readonly onDidChangeChatSessionProviderOptions?: Event<void>;
    provideChatSessionContent(
      resource: Uri,
      token: CancellationToken,
      context: ChatSessionContentContext
    ): ChatSession | Thenable<ChatSession>;
    provideHandleOptionsChange?(
      resource: Uri,
      updates: ReadonlyArray<ChatSessionOptionUpdate>,
      token: CancellationToken
    ): void | Thenable<void>;
    provideChatSessionProviderOptions?(
      token: CancellationToken
    ):
      | { optionGroups?: ChatSessionProviderOptionGroup[]; newSessionOptions?: Record<string, unknown> }
      | undefined
      | Thenable<
          { optionGroups?: ChatSessionProviderOptionGroup[]; newSessionOptions?: Record<string, unknown> } | undefined
        >;
  }

  export interface ChatSessionCapabilities {
    supportsInterruptions?: boolean;
  }

  export interface ChatSessionContext {
    readonly chatSessionItem: ChatSessionItem;
    readonly isUntitled: boolean;
  }

  export interface ChatContext {
    readonly chatSessionContext?: ChatSessionContext;
  }

  export interface ChatRequest {
    readonly modelConfiguration?: Record<string, unknown>;
  }

  export class ChatRequestTurn2 implements ChatRequestTurn {
    readonly prompt: string;
    readonly command: string | undefined;
    readonly references: ChatPromptReference[];
    readonly participant: string;
    readonly toolReferences: readonly ChatLanguageModelToolReference[];
    readonly editedFileEvents?: readonly unknown[];
    readonly id?: string;
    readonly modelId?: string;
    readonly modeInstructions2?: unknown;
    readonly isSystemInitiated?: boolean;
    constructor(
      prompt: string,
      command?: string,
      references?: ChatPromptReference[],
      participant?: string,
      toolReferences?: readonly ChatLanguageModelToolReference[],
      editedFileEvents?: readonly unknown[],
      id?: string,
      modelId?: string,
      modeInstructions2?: unknown,
      isSystemInitiated?: boolean
    );
  }

  export class ChatResponseTurn2 implements ChatResponseTurn {
    readonly response: ReadonlyArray<ChatResponsePart | ChatResponseWarningPart>;
    readonly result: ChatResult;
    readonly participant: string;
    readonly command?: string;
    constructor(
      response: ReadonlyArray<ChatResponsePart | ChatResponseWarningPart | ChatResponseCodeblockUriPart | ChatResponseTextEditPart>,
      result: ChatResult,
      participant: string,
      command?: string
    );
  }

  export class ChatResponseWarningPart {
    value: MarkdownString;
    constructor(value: string | MarkdownString);
  }

  export class ChatResponseCodeblockUriPart {
    value: Uri;
    isEdit?: boolean;
    undoStopId?: string;
    constructor(value: Uri, isEdit?: boolean, undoStopId?: string);
  }

  export class ChatResponseTextEditPart {
    uri: Uri;
    edits: TextEdit[];
    isDone?: boolean;
    constructor(uri: Uri, edits: TextEdit | TextEdit[] | true);
  }

  export class ChatResponseThinkingProgressPart {
    value: string | string[];
    id?: string;
    metadata?: Record<string, unknown>;
    constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>);
  }

  export class ChatSubagentToolInvocationData {
    description: string;
    agentName: string;
    prompt: string;
    result?: string;
    modelName?: string;
    constructor(description: string, agentName: string, prompt: string, result?: string);
  }

  export interface ChatTerminalToolInvocationData {
    commandLine: { original: string; toolEdited?: string; userEdited?: string };
    language: string;
    output?: { text: string; truncated?: boolean; lineCount?: number };
    state?: { exitCode?: number; duration?: number };
    presentationOverrides?: { commandLine: string; language?: string };
  }

  export interface ChatEmbedToolResultData {
    input: string;
    output: Array<{ mimeType: string; data: Uint8Array }>;
  }

  export interface ChatTodoListToolData {
    todoList: Array<{ id: string | number; title: string; status: 1 | 2 | 3 }>;
  }

  export class ChatToolInvocationPart {
    toolName: string;
    toolCallId: string;
    errorMessage?: string;
    invocationMessage?: string | MarkdownString;
    originMessage?: string | MarkdownString;
    pastTenseMessage?: string | MarkdownString;
    isConfirmed?: boolean;
    isComplete?: boolean;
    isError?: boolean;
    enablePartialUpdate?: boolean;
    presentation?: 'hidden' | 'hiddenAfterComplete';
    subAgentInvocationId?: string;
    subAgentName?: string;
    toolSpecificData?:
      | ChatTerminalToolInvocationData
      | ChatSubagentToolInvocationData
      | ChatEmbedToolResultData
      | ChatTodoListToolData
      | Record<string, unknown>;
    constructor(toolName: string, toolCallId: string, errorMessage?: string);
  }

  export interface ChatStatusItem extends Disposable {
    readonly id: string;
    title: string | { label: string; link?: string; helpText?: string };
    description: string;
    detail?: string;
    tooltip?: string | MarkdownString;
    show(): void;
    hide(): void;
  }

  export interface LanguageModelChatInformation {
    id: string;
    name: string;
    family: string;
    statusIcon?: ThemeIcon;
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxContextWindowTokens?: number;
    detail?: string;
    tooltip?: string | MarkdownString;
    pricing?: string;
    isUserSelectable?: boolean;
    isDefault?: boolean;
    targetChatSessionType?: string;
    configurationSchema?: {
      properties: Record<
        string,
        {
          type: string;
          title?: string;
          enum?: unknown[];
          enumItemLabels?: string[];
          enumDescriptions?: string[];
          default?: unknown;
          group?: string;
        }
      >;
    };
    capabilities: {
      imageInput?: boolean;
      toolCalling?: boolean | number;
    };
  }

  export interface LanguageModelChatInformationOptions {
    silent: boolean;
    configuration?: Record<string, unknown>;
  }

  export interface LanguageModelChatProvider {
    readonly onDidChangeLanguageModelChatInformation?: Event<void>;
    provideLanguageModelChatInformation(
      options: LanguageModelChatInformationOptions,
      token: CancellationToken
    ): ProviderResult<LanguageModelChatInformation[]>;
    provideLanguageModelChatResponse(
      model: LanguageModelChatInformation,
      messages: readonly LanguageModelChatRequestMessage[],
      options: LanguageModelChatResponseOptions,
      progress: Progress<LanguageModelResponsePart>,
      token: CancellationToken
    ): Thenable<void>;
    provideTokenCount(
      model: LanguageModelChatInformation,
      text: string | LanguageModelChatRequestMessage,
      token: CancellationToken
    ): Thenable<number>;
  }

  export namespace chat {
    export function createChatSessionItemController(
      id: string,
      refreshHandler: (token: CancellationToken) => Thenable<void> | void
    ): ChatSessionItemController;
    export function registerChatSessionContentProvider(
      scheme: string,
      provider: ChatSessionContentProvider,
      defaultChatParticipant: ChatParticipant,
      capabilities?: ChatSessionCapabilities
    ): Disposable;
  }

  export namespace lm {
    export function registerLanguageModelChatProvider(
      vendor: string,
      provider: LanguageModelChatProvider
    ): Disposable;
  }

  export namespace window {
    export function createChatStatusItem(id: string): ChatStatusItem;
  }

  export namespace workspace {
    export const isAgentSessionsWorkspace: boolean | undefined;
  }
}
