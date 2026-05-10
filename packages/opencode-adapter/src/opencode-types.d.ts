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
    $: any;
    worktree: any;
  }

  export interface Plugin {
    (ctx: PluginInput): Promise<{
      tool?: Record<string, any>;
      hooks?: Record<string, any>;
    }>;
  }

  export const tool: {
    schema: {
      string: (opts?: Record<string, unknown>) => any;
      number: (opts?: Record<string, unknown>) => any;
      boolean: (opts?: Record<string, unknown>) => any;
      array: (schema: any, opts?: Record<string, unknown>) => any;
      object: (schema: Record<string, any>, opts?: Record<string, unknown>) => any;
      enum: (values: string[], opts?: Record<string, unknown>) => any;
    };
    <TArgs = Record<string, unknown>>(opts: {
      description: string;
      args?: Record<string, any>;
      execute: (args: TArgs, context: { directory: string }) => Promise<string>;
    }): any;
  };
}