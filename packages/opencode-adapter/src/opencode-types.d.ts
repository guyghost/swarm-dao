// ============================================================
// OpenCode Plugin Type Stubs
// ============================================================
// Accurate type declarations for @opencode-ai/plugin, used when
// the real package is not installed (e.g. during standalone build
// or in downstream projects that only consume this adapter).
//
// These are derived from the official @opencode-ai/plugin v1.15+
// type declarations. They are intentionally declared as a module
// augmentation so TypeScript resolves them when the real package
// is absent. At runtime, the actual @opencode-ai/plugin types
// take precedence if the package is installed.
// ============================================================

declare module "@opencode-ai/plugin" {
  /**
   * Context object passed to every tool `execute()` callback.
   *
   * OpenCode populates this with session metadata, abort signals,
   * and helpers for interactive prompts (`ask`) and progress
   * metadata (`metadata`).
   */
  export interface ToolContext {
    /** Unique session identifier within the current project. */
    sessionID: string;
    /** Unique message identifier for the current turn. */
    messageID: string;
    /** Agent name that invoked the tool (e.g. `"coder"`). */
    agent: string;
    /**
     * Current project directory for this session.
     * Prefer this over `process.cwd()` when resolving relative paths.
     */
    directory: string;
    /**
     * Project worktree root for this session.
     * Useful for generating stable relative paths.
     */
    worktree: string;
    /** Abort signal — rejects if the user cancels the tool call. */
    abort: AbortSignal;
    /**
     * Emit progress metadata visible in the OpenCode UI.
     * Call with `{ title }` to update the tool's status label,
     * or `{ metadata: { key: value } }` to attach structured data.
     */
    metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
    /**
     * Request user permission interactively.
     * Used for operations that need explicit consent (file writes, etc.).
     */
    ask(input: {
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, unknown>;
    }): Promise<void>;
  }

  /**
   * A file attachment returned alongside tool output.
   */
  export type ToolAttachment = {
    type: "file";
    mime: string;
    url: string;
    filename?: string;
  };

  /**
   * Return type for tool `execute()`.
   *
   * Can be a plain string for simple text output, or an object with
   * structured metadata and file attachments for richer results.
   */
  export type ToolResult =
    | string
    | {
        title?: string;
        output: string;
        metadata?: Record<string, unknown>;
        attachments?: ToolAttachment[];
      };

  /**
   * The full context object passed to the `Plugin` function.
   *
   * Constructed by OpenCode at startup and includes the API client,
   * project metadata, filesystem helpers, and the Bun shell.
   */
  export interface PluginInput {
    /**
     * OpenCode API client for interacting with the OpenCode server.
     * Includes endpoints like `client.app.log()` for structured logging.
     */
    client: {
      app: {
        log(params: { service: string; level: string; message: string }): Promise<void>;
      };
    };
    /** The active OpenCode project descriptor. */
    project: {
      id: string;
      name: string;
      path: string;
      [key: string]: unknown;
    };
    /** Absolute path to the project's working directory. */
    directory: string;
    /** Absolute path to the project's git worktree root. */
    worktree: string;
    /** URL of the running OpenCode server instance. */
    serverUrl: URL;
    /**
     * Bun shell utility for executing commands.
     * Supports tagged-template syntax: `await ctx.$\`ls -la\``
     */
    $: unknown;
    /**
     * Experimental workspace registration API.
     * Allows plugins to define custom workspace types.
     */
    experimental_workspace: {
      register(type: string, adapter: unknown): void;
    };
  }

  /**
   * The shape of the return value from a Plugin function.
   *
   * Plugins may provide tools, lifecycle hooks, auth providers,
   * and model provider extensions. Only `tool` is required for
   * the Swarm DAO adapter.
   */
  export interface Hooks {
    /** Called when the plugin is being unloaded / disposed. */
    dispose?: () => Promise<void>;
    /** Called for every OpenCode event (message, tool call, etc.). */
    event?: (input: { event: unknown }) => Promise<void>;
    /** Called to modify the OpenCode configuration. */
    config?: (input: unknown) => Promise<void>;
    /**
     * Tool registry — map of tool names to their definitions.
     * This is the primary extension point for the Swarm DAO adapter.
     */
    tool?: {
      [key: string]: ToolDefinition;
    };
    /** Authentication hook for custom providers. */
    auth?: unknown;
    /** Model provider hook for custom LLM backends. */
    provider?: unknown;
    /** Called when a new chat message is received. */
    "chat.message"?: (input: unknown, output: unknown) => Promise<void>;
    /** Modify parameters sent to the LLM. */
    "chat.params"?: (input: unknown, output: unknown) => Promise<void>;
    /** Modify HTTP headers sent to the LLM provider. */
    "chat.headers"?: (input: unknown, output: unknown) => Promise<void>;
    /** Intercept permission prompts. */
    "permission.ask"?: (input: unknown, output: unknown) => Promise<void>;
    /** Called before a command is executed. */
    "command.execute.before"?: (input: unknown, output: unknown) => Promise<void>;
    /** Called before a tool is executed — can modify args. */
    "tool.execute.before"?: (input: unknown, output: unknown) => Promise<void>;
    /** Called after a tool is executed — can modify output. */
    "tool.execute.after"?: (input: unknown, output: unknown) => Promise<void>;
    /** Modify environment variables for shell commands. */
    "shell.env"?: (input: unknown, output: unknown) => Promise<void>;
    /** Modify tool definitions sent to the LLM. */
    "tool.definition"?: (input: unknown, output: unknown) => Promise<void>;
  }

  /**
   * The main plugin factory function.
   *
   * @param ctx - The OpenCode runtime context for this plugin.
   * @param options - Optional plugin-specific configuration.
   * @returns A Hooks object registering tools and lifecycle hooks.
   *
   * @example
   * ```typescript
   * const myPlugin: Plugin = async (ctx) => {
   *   return {
   *     tool: {
   *       hello: tool({
   *         description: "Say hello",
   *         args: { name: tool.schema.string() },
   *         async execute(args) { return `Hello, ${args.name}!`; },
   *       }),
   *     },
   *   };
   * };
   * ```
   */
  export type Plugin = (ctx: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>;

  /**
   * The inferred return type of the `tool()` factory function.
   * Represents a fully-defined tool ready for registration.
   */
  export type ToolDefinition = ReturnType<typeof tool>;

  /**
   * Factory function for defining OpenCode tools.
   *
   * Uses Zod schemas for argument validation. The `args` object
   * defines the tool's parameter schema, and `execute` is called
   * with validated arguments and a runtime context.
   *
   * @example
   * ```typescript
   * const myTool = tool({
   *   description: "Calculate the sum of two numbers",
   *   args: {
   *     a: tool.schema.number({ description: "First number" }),
   *     b: tool.schema.number({ description: "Second number" }),
   *   },
   *   async execute(args, ctx) {
   *     return `${args.a + args.b}`;
   *   },
   * });
   * ```
   */
  export function tool(input: {
    description: string;
    // biome-ignore lint/suspicious/noExplicitAny: Zod raw shape stub
    args?: Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
    execute(args: any, context: ToolContext): Promise<ToolResult>;
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
  }): any;

  export namespace tool {
    /**
     * Zod schema builder — `tool.schema` is the full Zod library.
     *
     * Use it to define argument schemas:
     * - `tool.schema.string()` — string arguments
     * - `tool.schema.number()` — numeric arguments
     * - `tool.schema.boolean()` — boolean arguments
     * - `tool.schema.array(tool.schema.string())` — arrays
     * - `tool.schema.object({ key: tool.schema.string() })` — objects
     * - `tool.schema.enum(["a", "b"])` — enum unions
     *
     * All Zod methods like `.optional()`, `.describe()`, `.default()`
     * are available on the resulting schemas.
     */
    // biome-ignore lint/suspicious/noExplicitAny: Zod schema builder — resolved at runtime when @opencode-ai/plugin is installed
    export const schema: any;
  }
}
