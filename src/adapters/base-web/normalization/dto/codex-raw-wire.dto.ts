export type CodexRawContentBlock =
  | { type: "input_text" | "text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string }
  | { type: string; [key: string]: unknown };

export interface CodexRawMessageItem {
  type: "message";
  id?: string;
  role: string;
  content: string | CodexRawContentBlock[];
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawToolFunction {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  [key: string]: unknown;
}

export interface CodexRawToolNamespace {
  type: "namespace";
  name: string;
  description?: string;
  tools: CodexRawToolSpec[];
  [key: string]: unknown;
}

export interface CodexRawToolCustom {
  type: "custom";
  name: string;
  description?: string;
  format?: unknown;
  [key: string]: unknown;
}

export interface CodexRawToolSearch {
  type: "tool_search";
  execution?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CodexRawToolSpec =
  | CodexRawToolFunction
  | CodexRawToolNamespace
  | CodexRawToolCustom
  | CodexRawToolSearch
  | { type: string; name?: string; description?: string; [key: string]: unknown };

export interface CodexRawAdditionalToolsItem {
  type: "additional_tools";
  id?: string;
  role?: string;
  tools: CodexRawToolSpec[];
  [key: string]: unknown;
}

export interface CodexRawFunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawFunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: unknown;
  [key: string]: unknown;
}

export interface CodexRawCustomToolCallItem {
  type: "custom_tool_call";
  id?: string;
  call_id: string;
  name: string;
  input: string;
  [key: string]: unknown;
}

export interface CodexRawCustomToolCallOutputItem {
  type: "custom_tool_call_output";
  id?: string;
  call_id: string;
  output: unknown;
  [key: string]: unknown;
}

export interface CodexRawCompactionTriggerItem {
  type: "compaction_trigger";
  [key: string]: unknown;
}

export type CodexRawInputItem =
  | CodexRawMessageItem
  | CodexRawAdditionalToolsItem
  | CodexRawFunctionCallItem
  | CodexRawFunctionCallOutputItem
  | CodexRawCustomToolCallItem
  | CodexRawCustomToolCallOutputItem
  | CodexRawCompactionTriggerItem
  | { type: string; [key: string]: unknown };

export interface CodexRawClientMetadata {
  thread_id?: string;
  turn_id?: string;
  "x-codex-turn-metadata"?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRawRequestWire {
  model: string;
  stream?: boolean;
  store?: boolean;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  client_metadata?: CodexRawClientMetadata;
  tools?: CodexRawToolSpec[];
  input?: CodexRawInputItem[];
  reasoning?: {
    effort?: string;
    [key: string]: unknown;
  };
  text?: {
    verbosity?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
