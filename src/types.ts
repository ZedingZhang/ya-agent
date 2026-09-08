export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments?: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export type ToolArguments = Record<string, unknown>;
export type ToolHandler = (arguments_: ToolArguments) => string | Promise<string>;

export interface TokenUsage {
  [key: string]: unknown;
}

export type WebMode = "auto" | "on" | "off";
export type OutputFormat = "auto" | "terminal" | "markdown";
