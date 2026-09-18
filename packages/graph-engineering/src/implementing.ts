// Graph Engineering implementing harness.
//
// The model emits a classifier verdict. This module prepends CLASSIFIER_CHARTER,
// harvests the last JSON object, composes it with tool evidence via
// evaluateAttempt, and maps the result to an implementer AI signal. It never
// submits EVALUATE, RETRY_AUTHORIZED, or a human event. Inner retries stay in
// `implementing`; outer retries after failed anchors remain evaluation-owned.

import {
  type AttemptDecision,
  type AttemptState,
  CLASSIFIER_CHARTER,
  DEFAULT_ATTEMPT_STATE,
  evaluateAttempt,
  type ToolEvidence,
  type VerdictValidation,
  validateVerdict,
} from "@guyghost/swarm-dao-core";
import { createGraphRunner, type GraphSubmissionResult, type PersistedGraphSnapshot } from "./runner.js";

export const DEFAULT_IMPLEMENTER_ROLE = `You implement the approved Graph Engineering model in this checkout. Keep the change minimal and focused. The harness runs tests, types, and lint; you never claim they passed. After each turn emit ONLY the classifier JSON object.`;

export const TOOLS_NOT_RUN: ToolEvidence = {
  tests: "not_run",
  types: "not_run",
  lint: "not_run",
};

export type TurnResult = Readonly<{ ok: true; transcript: string } | { ok: false; error: string }>;

export interface ImplementingPorts {
  /** One coding-agent turn. Fresh spawn is allowed; edits must persist on disk. */
  readonly turn: (prompt: string) => Promise<TurnResult>;
  /** Cheap inner checks. Called when the verdict is `done` or `run_tests`. */
  readonly runTools: (paths: readonly string[]) => Promise<ToolEvidence>;
  /** Hash of the checkout after a successful inner attempt. */
  readonly implementationHash: () => Promise<string>;
}

export type ImplementingLoopResult = Readonly<
  | { kind: "request_evaluation"; implementationHash: string; reason: string; turns: number }
  | { kind: "failed"; reason: string; turns: number }
  | { kind: "escalate"; reason: string; turns: number }
  | { kind: "block"; reason: string; turns: number }
>;

export type ImplementerSignal = Readonly<{
  type: "IMPLEMENTATION_READY" | "IMPLEMENTATION_FAILED";
  payload: Readonly<Record<string, string>>;
  evidence: readonly string[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Extract the last JSON object from a harvested transcript. Agents echo the
 * charter (which itself contains a JSON template), so earlier objects are ignored.
 */
export function extractLastJsonObject(content: string): Record<string, unknown> | null {
  const lastClose = content.lastIndexOf("}");
  if (lastClose === -1) return null;
  let open = content.lastIndexOf("{", lastClose);
  for (let scans = 0; open !== -1 && scans < 50; scans++, open = content.lastIndexOf("{", open - 1)) {
    const raw = content.slice(open, lastClose + 1);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // walk back to the previous opening brace
    }
  }
  return null;
}

export function harvestVerdict(transcript: string): VerdictValidation {
  const obj = extractLastJsonObject(transcript);
  if (obj === null) return { ok: false, errors: ["output is not valid JSON"] };
  return validateVerdict(obj);
}

export function composeImplementerPrompt(input: { task: string; role?: string; followUp?: string }): string {
  const task = input.task.trim();
  const chunks = [CLASSIFIER_CHARTER];
  const role = input.role?.trim() || DEFAULT_IMPLEMENTER_ROLE;
  chunks.push(role);
  chunks.push(task);
  const followUp = input.followUp?.trim();
  if (followUp) chunks.push(followUp);
  return chunks.join("\n\n");
}

export function followUpFromDecision(decision: Extract<AttemptDecision, { kind: "re_prompt" | "continue" }>): string {
  if (decision.kind === "re_prompt") {
    return [
      "Your previous output was not a valid classifier verdict:",
      ...decision.errors.map((error) => `- ${error}`),
      "Emit ONLY the JSON object. No markdown fences, no extra keys.",
    ].join("\n");
  }
  const paths =
    decision.nextAction === "edit_file" && decision.affectedPaths.length > 0
      ? `\naffectedPaths: ${decision.affectedPaths.join(", ")}`
      : "";
  return [
    "Harness decision: continue.",
    `nextAction: ${decision.nextAction}${paths}`,
    `reason: ${decision.reason}`,
    "Do the work, then emit a new JSON verdict. Do not claim tests passed.",
  ].join("\n");
}

const shouldRunTools = (validation: VerdictValidation): boolean =>
  validation.ok && (validation.verdict.status === "done" || validation.verdict.nextAction === "run_tests");

const isBudgetEscalate = (retryCount: number, maxRetries: number): boolean => retryCount >= maxRetries;

/**
 * Inner coding loop. Stays in Graph `implementing`. `done` with tool evidence
 * requests evaluation; human escalate / environment block emit no graph event.
 * Exhausted inner budget becomes IMPLEMENTATION_FAILED (outer auto-retry).
 */
export async function runImplementingLoop(
  input: { task: string; role?: string; state?: AttemptState },
  ports: ImplementingPorts,
): Promise<ImplementingLoopResult> {
  const task = input.task.trim();
  if (task.length === 0) return { kind: "block", reason: "implementing task is empty", turns: 0 };

  const state = input.state ?? DEFAULT_ATTEMPT_STATE;
  let retryCount = 0;
  let followUp: string | undefined;
  let turns = 0;

  while (true) {
    const prompted = await ports.turn(composeImplementerPrompt({ task, role: input.role, followUp }));
    if (!prompted.ok) return { kind: "block", reason: prompted.error, turns };

    const validation = harvestVerdict(prompted.transcript);
    turns += 1;

    let tools: ToolEvidence = TOOLS_NOT_RUN;
    if (shouldRunTools(validation)) {
      try {
        tools = await ports.runTools(validation.ok ? validation.verdict.affectedPaths : []);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "block", reason: `tool checks could not run: ${message}`, turns };
      }
    }

    const decision = evaluateAttempt(validation, tools, { ...state, retryCount });

    if (decision.kind === "re_prompt" || decision.kind === "continue") {
      followUp = followUpFromDecision(decision);
      retryCount += 1;
      continue;
    }
    if (decision.kind === "block") return { kind: "block", reason: decision.reason, turns };
    if (decision.kind === "escalate") {
      return isBudgetEscalate(retryCount, state.maxRetries)
        ? { kind: "failed", reason: decision.reason, turns }
        : { kind: "escalate", reason: decision.reason, turns };
    }
    const implementationHash = (await ports.implementationHash()).trim();
    if (implementationHash.length === 0) {
      return { kind: "block", reason: "implementation hash was empty", turns };
    }
    return { kind: "request_evaluation", implementationHash, reason: decision.reason, turns };
  }
}

/** Map a finished inner loop to an implementer AI signal, or null if the host must stop. */
export function implementerSignalFrom(result: ImplementingLoopResult): ImplementerSignal | null {
  if (result.kind === "request_evaluation") {
    return {
      type: "IMPLEMENTATION_READY",
      payload: { implementationHash: result.implementationHash },
      evidence: [`classifier requested evaluation: ${result.reason}`.slice(0, 500)],
    };
  }
  if (result.kind === "failed") {
    return {
      type: "IMPLEMENTATION_FAILED",
      payload: { reason: result.reason.slice(0, 500) },
      evidence: [`classifier inner loop failed after ${result.turns} turn(s)`],
    };
  }
  return null;
}

export type GraphImplementingResult = Readonly<{
  loop: ImplementingLoopResult;
  submitted: boolean;
  snapshot: PersistedGraphSnapshot;
  submission?: GraphSubmissionResult;
  error?: string;
}>;

/**
 * Drive one implementing attempt on an existing graph run. Refuses unless the
 * run is in `implementing`. Never emits EVALUATE.
 */
export async function runGraphImplementing(options: {
  evidenceRoot: string;
  runId: string;
  task: string;
  role?: string;
  state?: AttemptState;
  ports: ImplementingPorts;
  now?: () => string;
}): Promise<GraphImplementingResult> {
  const runner = await createGraphRunner({
    evidenceRoot: options.evidenceRoot,
    runId: options.runId,
    ...(options.now ? { clock: options.now } : {}),
  });
  const before = runner.snapshot();
  if (before.state !== "implementing") {
    return {
      loop: { kind: "block", reason: `run is in ${before.state}, not implementing`, turns: 0 },
      submitted: false,
      snapshot: before,
      error: `run is in ${before.state}, not implementing`,
    };
  }

  const loop = await runImplementingLoop(
    { task: options.task, role: options.role, state: options.state },
    options.ports,
  );
  const signal = implementerSignalFrom(loop);
  if (signal === null) {
    return { loop, submitted: false, snapshot: runner.snapshot() };
  }

  const submission = await runner.submit({
    runId: options.runId,
    type: signal.type,
    source: "ai",
    producer: "implementer",
    occurredAt: (options.now ?? (() => new Date().toISOString()))(),
    payload: signal.payload,
    evidence: signal.evidence,
  });
  return {
    loop,
    submitted: submission.accepted,
    snapshot: submission.snapshot,
    submission,
    ...(submission.accepted ? {} : { error: submission.issues.join("; ") }),
  };
}
