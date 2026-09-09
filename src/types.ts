export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ImageDetail = "low" | "high" | "original" | "auto";

export interface ChatTextContentPart {
  type: "text";
  text: string;
}

export interface ChatImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: ImageDetail;
  };
}

export interface ChatFileContentPart {
  type: "file";
  file_id: string;
}

export type UserImageContentPart = ChatImageUrlContentPart | ChatFileContentPart;
export type UserContentPart = ChatTextContentPart | UserImageContentPart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | UserContentPart[] | null;
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
