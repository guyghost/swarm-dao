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
      execute: (
        toolCallId: string,
        params: TParams,
        signal?: AbortSignal,
        onUpdate?: (update: {
          content: Array<{ type: string; text: string }>;
          details: Record<string, unknown>;
        }) => void,
        ctx?: ExtensionCommandContext,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
    }): void;
    registerCommand(
      name: string,
      command: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ): void;
    on(
      event: "session_start" | "session_tree" | "before_agent_start",
      // biome-ignore lint/suspicious/noExplicitAny: stub type for external module event parameter
      handler: (event: any, ctx: ExtensionCommandContext) => Promise<{ systemPrompt?: string } | undefined>,
    ): void;
  }
  export interface ExtensionCommandContext {
    ui?: { setWorkingMessage?: (msg: string) => void };
    sessionManager?: { getBranch: () => string };
  }
}

declare module "@earendil-works/pi-ai" {
  // biome-ignore lint/suspicious/noExplicitAny: stub type for external module
  export function StringEnum(values: string[], options?: Record<string, unknown>): any;
}

declare module "typebox" {
  export const Type: {
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    Object(props: Record<string, unknown>, options?: Record<string, unknown>): any;
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    String(options?: Record<string, unknown>): any;
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    Number(options?: Record<string, unknown>): any;
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    Boolean(options?: Record<string, unknown>): any;
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    Optional(schema: any): any;
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    Array(schema: any, options?: Record<string, unknown>): any;
    // biome-ignore lint/suspicious/noExplicitAny: stub types for external module typebox
    Enum(values: any, options?: Record<string, unknown>): any;
  };
}
