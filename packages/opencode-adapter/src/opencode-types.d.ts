// Stubs for OpenCode plugin types — used for compilation when OpenCode is not installed.
// These are replaced by the real types at runtime.

declare module "@opencode-ai/plugin" {
  export interface PluginInput {
    project: string;
    directory: string;
    client: {
      app: {
        log: (params: { service: string; level: string; message: string }) => Promise<void>;
      };
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub type for external module
    $: any;
    // biome-ignore lint/suspicious/noExplicitAny: stub type for external module
    worktree: any;
  }

  export type Plugin = (ctx: PluginInput) => Promise<{
    // biome-ignore lint/suspicious/noExplicitAny: stub type for external module
    tool?: Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: stub type for external module
    hooks?: Record<string, any>;
  }>;

  export const tool: {
    schema: {
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      string: (opts?: Record<string, unknown>) => any;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      number: (opts?: Record<string, unknown>) => any;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      boolean: (opts?: Record<string, unknown>) => any;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      array: (schema: any, opts?: Record<string, unknown>) => any;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      object: (schema: Record<string, any>, opts?: Record<string, unknown>) => any;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      enum: (values: string[], opts?: Record<string, unknown>) => any;
    };
    <TArgs = Record<string, unknown>>(opts: {
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
      args?: Record<string, any>;
      execute: (args: TArgs, context: { directory: string }) => Promise<string>;
      // biome-ignore lint/suspicious/noExplicitAny: stub types for external module
    }): any;
  };
}
