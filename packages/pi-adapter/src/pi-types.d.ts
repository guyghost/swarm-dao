// ============================================================
// Swarm DAO — Pi Coding Agent Type Stubs
// ============================================================
// Compilation-only types for `@earendil-works/pi-coding-agent`,
// `@earendil-works/pi-ai`, and `typebox`.
//
// At runtime the real packages provide the implementations.
// These stubs exist so the adapter can compile without requiring
// Pi as a hard dependency.

// ── TypeBox (schema builder) ─────────────────────────────────

declare module "typebox" {
  /**
   * Static schema builder — mirrors the real TypeBox API surface used by the adapter.
   *
   * Returns plain JSON Schema objects that satisfy Pi's parameter validation.
   * The return types are intentionally loose (`Record<string, unknown>`)
   * because the adapter only passes them to Pi, which validates at runtime.
   */
  const Type: {
    /** Create an object schema from property schemas */
    Object(
      properties: Record<string, Record<string, unknown>>,
      options?: Record<string, unknown>,
    ): Record<string, unknown>;

    /** Create a string schema */
    String(options?: Record<string, unknown>): Record<string, unknown>;

    /** Create a number schema */
    Number(options?: Record<string, unknown>): Record<string, unknown>;

    /** Create a boolean schema */
    Boolean(options?: Record<string, unknown>): Record<string, unknown>;

    /** Mark a schema as optional (not required in parent object) */
    Optional(schema: Record<string, unknown>): Record<string, unknown>;

    /** Create an array schema */
    Array(items: Record<string, unknown>, options?: Record<string, unknown>): Record<string, unknown>;

    /** Create an enum schema from a set of string values */
    Enum(values: Record<string, string>, options?: Record<string, unknown>): Record<string, unknown>;
  };
}

// ── Pi AI utilities ──────────────────────────────────────────

declare module "@earendil-works/pi-ai" {
  /**
   * Create a JSON Schema enum from an array of strings.
   *
   * Used to define the `type` parameter of `dao_propose` so the LLM
   * only picks valid proposal categories.
   *
   * @param values - Array of allowed string values
   * @param options - Optional schema metadata (e.g. `{ description }`)
   * @returns A TypeBox-compatible enum schema
   *
   * @example
   * ```ts
   * StringEnum(["product-feature", "security-change"], { description: "Proposal type" })
   * ```
   */
  export function StringEnum(values: readonly string[], options?: Record<string, unknown>): Record<string, unknown>;
}

// ── Pi Coding Agent Extension API ────────────────────────────

declare module "@earendil-works/pi-coding-agent" {
  /**
   * Pi's Extension API — the main surface area for integrating
   * external tools, commands, and event hooks into the Pi
   * coding agent.
   *
   * Instances are created by Pi and passed to the extension's
   * default export function at load time.
   *
   * @example
   * ```ts
   * export default function myExtension(pi: ExtensionAPI) {
   *   pi.registerTool({ name: "hello", ... });
   *   pi.registerCommand("/hello", { ... });
   *   pi.on("session_start", async () => undefined);
   * }
   * ```
   */
  export interface ExtensionAPI {
    // ── Tool Registration ──────────────────────────────────

    /**
     * Register a tool that the LLM can invoke.
     *
     * @typeParam TParams - The resolved parameter type the tool expects
     * @param tool - Tool definition including name, schema, and execute handler
     */
    registerTool<TParams = Record<string, unknown>>(tool: {
      /** Unique tool name (snake_case convention, e.g. `dao_propose`) */
      name: string;
      /** Human-readable label shown in UI */
      label?: string;
      /** Description the LLM uses to decide when to call this tool */
      description: string;
      /** TypeBox schema describing the tool's parameters */
      parameters: unknown;
      /** Optional prompt snippet the LLM can use to guide tool usage */
      promptSnippet?: string;
      /**
       * Execute the tool.
       *
       * @param toolCallId - Unique ID for this invocation
       * @param params - Validated parameters matching the schema
       * @param signal - AbortSignal for cancellation
       * @param onUpdate - Callback for streaming incremental results
       * @param ctx - Pi command context (UI, session info)
       */
      execute: (
        toolCallId: string,
        params: TParams,
        signal?: AbortSignal,
        onUpdate?: (update: ToolUpdate) => void,
        ctx?: ExtensionCommandContext,
      ) => Promise<ToolResult>;
    }): void;

    // ── Command Registration ───────────────────────────────

    /**
     * Register a slash-command (e.g. `/dao`).
     *
     * @param name - Command name including the leading `/`
     * @param command - Command definition with handler
     */
    registerCommand(
      name: string,
      command: {
        /** Short description shown in command palette */
        description: string;
        /**
         * Handle the command invocation.
         *
         * @param args - Raw text after the command (may be empty string)
         * @param ctx - Pi command context
         * @returns Response text, or undefined for no output
         */
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<string | undefined>;
      },
    ): void;

    // ── Event Registration ─────────────────────────────────

    /**
     * Subscribe to a Pi lifecycle event.
     *
     * @param event - The event to subscribe to
     * @param handler - Async handler; return value depends on event type
     */
    on(
      event: PiEventName,
      handler: (
        event: BeforeAgentStartEvent | Record<string, unknown>,
        ctx: ExtensionCommandContext,
      ) => Promise<PiEventHandlerResult | undefined>,
    ): void;
  }

  /**
   * Represents a single content block returned by a tool execution.
   * Currently only `text` blocks are supported.
   */
  interface ToolContentBlock {
    /** Discriminator — always `"text"` for text blocks */
    type: "text";
    /** The text payload */
    text: string;
  }

  /**
   * The shape returned by every tool's `execute()` method.
   * Follows the Model Context Protocol (MCP) tool-result convention.
   */
  interface ToolResult {
    /** One or more content blocks */
    content: ToolContentBlock[];
    /** Opaque details forwarded to the host */
    details: Record<string, unknown>;
  }

  /**
   * Incremental update sent from a long-running tool via the
   * `onUpdate` callback. Same shape as `ToolResult`.
   */
  interface ToolUpdate {
    content: ToolContentBlock[];
    details: Record<string, unknown>;
  }

  /**
   * Context object passed to command and tool handlers.
   * Provides access to Pi's UI and session management features.
   */
  interface ExtensionCommandContext {
    /** UI helpers for feedback during execution */
    ui?: {
      /** Show a transient status message to the user */
      setWorkingMessage?: (message: string) => void;
    };
    /** Session management utilities */
    sessionManager?: {
      /** Get the current branch identifier */
      getBranch: () => string;
    };
  }

  /**
   * Event names that Pi emits and extensions can subscribe to.
   *
   * - `session_start` — fires once when a Pi session begins
   * - `session_tree` — fires when the conversation tree is modified
   * - `before_agent_start` — fires before each agent turn; allows
   *   the handler to amend the system prompt
   */
  type PiEventName = "session_start" | "session_tree" | "before_agent_start";

  /**
   * Event payload for `before_agent_start`.
   * Contains the system prompt that will be sent to the agent,
   * which handlers may extend.
   */
  interface BeforeAgentStartEvent {
    /** The system prompt that will be sent to the LLM */
    systemPrompt: string;
  }

  /**
   * Result of an event handler. Currently only `systemPrompt`
   * overrides are supported (used by `before_agent_start`).
   */
  interface PiEventHandlerResult {
    /** If provided, replaces the system prompt for the upcoming agent turn */
    systemPrompt?: string;
  }

  // Re-export context types so consumers can import them directly
  export type { ExtensionCommandContext };
}
