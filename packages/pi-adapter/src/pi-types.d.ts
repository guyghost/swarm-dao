// Stubs for Pi coding agent types — used for compilation when Pi is not installed.
// These are replaced by the real types at runtime.

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool<TParams = Record<string, unknown>>(tool: {
      name: string;
      label?: string;
      description: string;
      parameters: unknown;
      promptSnippet?: string;
      execute: (toolCallId: string, params: TParams, signal?: AbortSignal, onUpdate?: (update: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }) => void, ctx?: ExtensionCommandContext) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
    }): void;
    registerCommand(name: string, command: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void;
    on(event: "session_start" | "session_tree" | "before_agent_start", handler: (event: any, ctx: ExtensionCommandContext) => Promise<{ systemPrompt?: string } | void>): void;
  }
  export interface ExtensionCommandContext {
    ui?: { setWorkingMessage?: (msg: string) => void };
    sessionManager?: { getBranch: () => string };
  }
}

declare module "@earendil-works/pi-ai" {
  export function StringEnum(values: string[], options?: Record<string, unknown>): any;
}

declare module "typebox" {
  export const Type: {
    Object(props: Record<string, unknown>, options?: Record<string, unknown>): any;
    String(options?: Record<string, unknown>): any;
    Number(options?: Record<string, unknown>): any;
    Boolean(options?: Record<string, unknown>): any;
    Optional(schema: any): any;
    Array(schema: any, options?: Record<string, unknown>): any;
    Enum(values: any, options?: Record<string, unknown>): any;
  };
}