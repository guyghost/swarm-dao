import { type ActorRefFrom, assign, createActor, setup } from "xstate";

export const REQUIRED_PRODUCT_ANCHORS = [
  "qualification-passed",
  "vote-quorum",
  "budget-envelope",
  "controls-passed",
  "auto-ship-policy",
  "observation-window",
  "rollback-path-exists",
  "frozen-set-intact",
  "regression",
] as const;

export const PRODUCT_TERMINAL_STATES = ["validated", "rejected"] as const;

export const PRODUCT_VOTE_EXPIRY_HOURS = { standard: 72, criticalSecurity: 12 } as const;
export const PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS = 3;
export const PRODUCT_MEMBER_QUOTA_RENEWAL_MINUTES = 300;

export const PRODUCT_ALLOWED_CATEGORIES = ["performance", "refactor", "tooling", "docs", "security"] as const;

// Anchors auto-sealed by machine actions (the tool never records these).
// `rollback-path-exists` is NOT auto-sealed: it is an external, tool-recorded
// anchor so the ship gate trusts a verified artifact rather than a bare draft
// string (the verifier records it via ANCHOR_RECORDED only after the rollback
// command confirms the artifact is genuine).
export const PRODUCT_AUTO_SEALED_ANCHORS = [
  "qualification-passed",
  "vote-quorum",
  "budget-envelope",
  "controls-passed",
  "auto-ship-policy",
  "observation-window",
] as const;

// Anchors the tool records via ANCHOR_RECORDED (the machine never auto-seals these).
export const PRODUCT_EXTERNAL_ANCHORS = ["frozen-set-intact", "regression", "rollback-path-exists"] as const;

/**
 * Subset of required anchors that must ALREADY be passed at the VERIFY_EVALUATE
 * ship gate. It deliberately EXCLUDES `observation-window` (sealed only when the
 * observation window completes) and the anchors `sealVerificationAnchors` itself
 * seals when it transitions to `ship` (`controls-passed`, `auto-ship-policy`) —
 * those decisions are re-derived from draft/controls/budget by `canAutoShip`,
 * never read back as their own gate. `rollback-path-exists` IS included because
 * it is now an external, tool-recorded anchor (not sealed by the ship action),
 * so there is no chicken-and-egg: the verifier must have already recorded it.
 */
export const PRODUCT_SHIP_GATE_ANCHORS = [
  "qualification-passed",
  "vote-quorum",
  "budget-envelope",
  "frozen-set-intact",
  "regression",
  "rollback-path-exists",
] as const;

export type ProductAnchorName = (typeof REQUIRED_PRODUCT_ANCHORS)[number];
export type ProductSignalSource = "ai" | "tool" | "human" | "system";
export type ProductAnchorStatus = "passed" | "failed";
export type ProductCategory = (typeof PRODUCT_ALLOWED_CATEGORIES)[number];
export type VoteKind = "standard" | "criticalSecurity";
export type ObservationMetric = "errors" | "aiCost" | "latency" | "satisfaction";
export type ReviewResolution = "scope-reduced" | "budget-expanded" | "abandoned" | "deploy-authorized";

export type ProposalDraft = Readonly<{
  scope: string;
  category: ProductCategory;
  touchesSensitive: boolean;
  dependencies: readonly string[];
  budgetAllocation: number;
  rollbackArtifact: string;
  evidence: string;
}>;

export type VoteConfig = Readonly<{
  quorum: number;
  kind: VoteKind;
  expiryHours: number;
}>;

export type BudgetEnvelope = Readonly<{
  initial: number;
  consumed: number;
  history: readonly BudgetAction[];
}>;

export type BudgetAction = Readonly<{
  amount: number;
  description: string;
  evidence: string;
}>;

export type ControlResult = Readonly<{
  name: string;
  status: ProductAnchorStatus;
  evidence: string;
}>;

export type ObservationSample = Readonly<{
  metric: ObservationMetric;
  value: number;
  threshold: number;
  exceeded: boolean;
  evidence: string;
}>;

export type ProductAnchorResult = Readonly<{
  status: ProductAnchorStatus;
  evidence: string;
}>;

export type ProductContext = {
  runId: string;
  proposalId: string | null;
  improvementCycleId: string | null;
  draft: ProposalDraft | null;
  voteConfig: VoteConfig | null;
  favorableVotes: number;
  budget: BudgetEnvelope | null;
  controls: Record<string, ControlResult>;
  observationSamples: ObservationSample[];
  contactVoteOpen: boolean;
  contactVoteQuorumReached: boolean;
  contactRelayAuthorized: boolean;
  reviewReason: string | null;
  permissionsCleared: boolean;
  permissionEvidence: string | null;
  signalLog: readonly string[];
  anchors: Partial<Record<ProductAnchorName, ProductAnchorResult>>;
  terminalReason: string | null;
};

export type ProductEvent =
  | { type: "AGENT_SIGNAL"; source: ProductSignalSource; note: string }
  | { type: "FEEDBACK_AGGREGATED"; source: ProductSignalSource; summary: string }
  | { type: "PROPOSAL_DRAFTED"; source: ProductSignalSource; draft: ProposalDraft }
  | { type: "OPEN_PROPOSITION"; source: ProductSignalSource }
  | {
      type: "QUALIFICATION_RUN";
      source: ProductSignalSource;
      permissionCleared: boolean;
      permissionEvidence: string;
    }
  | { type: "VOTE_OPENED"; source: ProductSignalSource; config: VoteConfig }
  | { type: "VOTE_CAST"; source: ProductSignalSource; favorable: number }
  | { type: "VOTE_EVALUATE"; source: ProductSignalSource }
  | { type: "VOTE_EXPIRED"; source: ProductSignalSource }
  | { type: "BUDGET_CHARGE"; source: ProductSignalSource; action: BudgetAction }
  | { type: "EXECUTION_DONE"; source: ProductSignalSource }
  | { type: "VERIFY_RUN"; source: ProductSignalSource; control: ControlResult }
  | { type: "VERIFY_EVALUATE"; source: ProductSignalSource }
  | { type: "OBSERVATION_SAMPLE"; source: ProductSignalSource; sample: ObservationSample }
  | { type: "OBSERVATION_EVALUATE"; source: ProductSignalSource; windowElapsed: boolean }
  | {
      type: "ANCHOR_RECORDED";
      source: ProductSignalSource;
      anchor: ProductAnchorName;
      status: ProductAnchorStatus;
      evidence: string;
    }
  | { type: "CORRECTIVE_PROPOSITION_OPENED"; source: ProductSignalSource }
  | { type: "REVIEW_RESOLVED"; source: ProductSignalSource; resolution: ReviewResolution; expandedBudget?: number }
  | { type: "RETRY_VERIFICATION_AUTHORIZED"; source: ProductSignalSource }
  | { type: "CONTACT_VOTE_OPENED"; source: ProductSignalSource }
  | { type: "CONTACT_VOTE_QUORUM"; source: ProductSignalSource; reached: boolean }
  | { type: "CONTACT_RELAY_AUTHORIZED"; source: ProductSignalSource }
  | { type: "PERMISSION_DENIED"; source: ProductSignalSource; reason: string }
  | { type: "CANCEL"; source: ProductSignalSource; reason: string };

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProposalDraft = (value: unknown): value is ProposalDraft => {
  if (!isRecord(value)) return false;
  const deps = value.dependencies;
  return (
    isNonEmpty(value.scope) &&
    (PRODUCT_ALLOWED_CATEGORIES as readonly string[]).includes(value.category as string) &&
    typeof value.touchesSensitive === "boolean" &&
    Array.isArray(deps) &&
    (deps as unknown[]).every((dep) => isNonEmpty(dep)) &&
    typeof value.budgetAllocation === "number" &&
    value.budgetAllocation >= 0 &&
    isNonEmpty(value.rollbackArtifact) &&
    isNonEmpty(value.evidence)
  );
};

export const isRequiredProductAnchor = (value: unknown): value is ProductAnchorName =>
  typeof value === "string" && REQUIRED_PRODUCT_ANCHORS.includes(value as ProductAnchorName);

// --- Deterministic policies. Pure. The model — not the tool adapter — decides. ---

/**
 * Qualification: scope, dependencies, allowed category, affirmative permission
 * clearance, budget presence, and rollback artifact. Permission clearance is an
 * explicit, evidence-backed boolean carried by QUALIFICATION_RUN — qualification
 * never passes on the mere absence of a denial. Sensitive security work may pass
 * (it is auto-votable) but is flagged, which later forbids auto-ship.
 */
export const qualifyProposal = (
  draft: ProposalDraft | null,
  permissionsCleared: boolean,
): { qualified: boolean; reason: string } => {
  if (!draft) return { qualified: false, reason: "missing draft" };
  if (!isNonEmpty(draft.scope)) return { qualified: false, reason: "empty scope" };
  if (!(PRODUCT_ALLOWED_CATEGORIES as readonly string[]).includes(draft.category)) {
    return { qualified: false, reason: "category not allowed" };
  }
  if (!Array.isArray(draft.dependencies) || draft.dependencies.some((dep) => !isNonEmpty(dep))) {
    return { qualified: false, reason: "unresolvable dependencies" };
  }
  if (!permissionsCleared) return { qualified: false, reason: "permissions not cleared" };
  if (draft.budgetAllocation <= 0) return { qualified: false, reason: "no budget allocated" };
  if (!isNonEmpty(draft.rollbackArtifact)) return { qualified: false, reason: "no rollback artifact" };
  return { qualified: true, reason: "scope, dependencies, category, permissions, and budget validated" };
};

/** Vote tally: quorum is a minimum favorable-vote threshold, not participation. */
export const tallyProductVotes = (favorable: number, config: VoteConfig | null): { quorumReached: boolean } => {
  if (!config) return { quorumReached: false };
  return { quorumReached: config.quorum > 0 && favorable >= config.quorum };
};

/** Budget ledger: remaining = initial - consumed; never negative. */
export const applyBudgetCharge = (envelope: BudgetEnvelope | null, action: BudgetAction): BudgetEnvelope => {
  if (!envelope) return { initial: 0, consumed: 0, history: [] };
  const consumed = envelope.consumed + Math.max(0, action.amount);
  return {
    initial: envelope.initial,
    consumed,
    history: [...envelope.history, action],
  };
};

export const budgetRemaining = (envelope: BudgetEnvelope | null): number => {
  if (!envelope) return 0;
  return Math.max(0, envelope.initial - envelope.consumed);
};

/**
 * Auto-ship gate. Decides deterministically from the draft + controls + budget.
 * Does NOT depend on an anchor it would itself set (no chicken-and-egg).
 * Sensitive security work is forbidden from auto-ship even if reversible.
 */
export const canAutoShip = (context: {
  draft: ProposalDraft | null;
  controls: Record<string, ControlResult>;
  budget: BudgetEnvelope | null;
}): { allowed: boolean; reason: string } => {
  const { draft, controls, budget } = context;
  if (!draft) return { allowed: false, reason: "missing draft" };
  const controlValues = Object.values(controls);
  if (controlValues.length === 0) return { allowed: false, reason: "no controls recorded" };
  if (controlValues.some((c) => c.status !== "passed")) return { allowed: false, reason: "a control failed" };
  if (!(PRODUCT_ALLOWED_CATEGORIES as readonly string[]).includes(draft.category)) {
    return { allowed: false, reason: "category not allowed for auto-ship" };
  }
  if (draft.category === "security" || draft.touchesSensitive) {
    return { allowed: false, reason: "sensitive change requires human review before deploy" };
  }
  if (!isNonEmpty(draft.rollbackArtifact)) return { allowed: false, reason: "no rollback artifact" };
  if (budgetRemaining(budget) <= 0) return { allowed: false, reason: "budget exhausted" };
  return { allowed: true, reason: "reversible, allowed, rollback exists, budget remains, not sensitive" };
};

const isSensitiveDraft = (draft: ProposalDraft | null): boolean =>
  draft !== null && (draft.category === "security" || draft.touchesSensitive === true);

/**
 * Human deploy-authorization gate for SENSITIVE changes only. Auto-ship forbids
 * sensitive work; such a change that otherwise passes verification routes to
 * Review, where the human owner may authorize deployment. This gate requires:
 * the draft is sensitive, every control passed, budget remains, and the
 * ship-gate anchors (including the externally verified rollback path) hold.
 * It can never be exercised by an AI source — REVIEW_RESOLVED is human-only.
 */
export const canHumanAuthorizeSensitiveDeploy = (context: {
  draft: ProposalDraft | null;
  controls: Record<string, ControlResult>;
  budget: BudgetEnvelope | null;
  anchors: Partial<Record<ProductAnchorName, ProductAnchorResult>>;
}): { allowed: boolean; reason: string } => {
  const { draft, controls, budget, anchors } = context;
  if (!draft) return { allowed: false, reason: "missing draft" };
  if (!isSensitiveDraft(draft)) return { allowed: false, reason: "deploy-authorized is only for sensitive changes" };
  const controlValues = Object.values(controls);
  if (controlValues.length === 0 || controlValues.some((c) => c.status !== "passed")) {
    return { allowed: false, reason: "every control must pass before deploy" };
  }
  if (budgetRemaining(budget) <= 0) return { allowed: false, reason: "budget exhausted" };
  if (!shipGateAnchorsPassed(anchors)) return { allowed: false, reason: "ship-gate anchors not passed" };
  return { allowed: true, reason: "human-authorized deploy of sensitive, verified, reversible change" };
};

/**
 * Observation gate. Priorities: errors > aiCost > latency. Satisfaction is a
 * signal only and can NEVER confirm degradation. A single measurement never
 * confirms; require N consecutive threshold-crossing measurements on the
 * highest-priority breached metric.
 */
export const evaluateObservation = (
  samples: ObservationSample[],
  _windowElapsed: boolean,
): { confirmed: boolean; metric: ObservationMetric | null } => {
  const priorities: ObservationMetric[] = ["errors", "aiCost", "latency"];
  for (const metric of priorities) {
    const forMetric = samples.filter((s) => s.metric === metric);
    if (forMetric.length < PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS) continue;
    const tail = forMetric.slice(-PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS);
    if (tail.every((s) => s.exceeded)) return { confirmed: true, metric };
  }
  return { confirmed: false, metric: null };
};

/** True only when every required anchor is passed. Terminal invariant at `validated`. */
export const allRequiredAnchorsPassed = (anchors: Partial<Record<ProductAnchorName, ProductAnchorResult>>): boolean =>
  REQUIRED_PRODUCT_ANCHORS.every(
    (anchor) => anchors[anchor]?.status === "passed" && isNonEmpty(anchors[anchor]?.evidence),
  );

/** True only when every ship-gate anchor is passed. Used at the VERIFY_EVALUATE ship gate. */
export const shipGateAnchorsPassed = (anchors: Partial<Record<ProductAnchorName, ProductAnchorResult>>): boolean =>
  PRODUCT_SHIP_GATE_ANCHORS.every(
    (anchor) => anchors[anchor]?.status === "passed" && isNonEmpty(anchors[anchor]?.evidence),
  );

export interface ProductMachineInput {
  runId: string;
  proposalId?: string | null;
  improvementCycleId?: string | null;
}

const initialContext = (input: ProductMachineInput): ProductContext => ({
  runId: input.runId,
  proposalId: input.proposalId ?? null,
  improvementCycleId: input.improvementCycleId ?? null,
  draft: null,
  voteConfig: null,
  favorableVotes: 0,
  budget: null,
  controls: {},
  observationSamples: [],
  contactVoteOpen: false,
  contactVoteQuorumReached: false,
  contactRelayAuthorized: false,
  reviewReason: null,
  permissionsCleared: false,
  permissionEvidence: null,
  signalLog: [],
  anchors: {},
  terminalReason: null,
});

const productSetup = setup({
  types: {
    context: {} as ProductContext,
    events: {} as ProductEvent,
    input: {} as ProductMachineInput,
  },
  guards: {
    isAiAgentSignal: ({ event }) => event.type === "AGENT_SIGNAL" && event.source === "ai" && isNonEmpty(event.note),
    isAiFeedbackAggregated: ({ event }) =>
      event.type === "FEEDBACK_AGGREGATED" && event.source === "ai" && isNonEmpty(event.summary),
    isAiProposalDrafted: ({ event }) =>
      event.type === "PROPOSAL_DRAFTED" && event.source === "ai" && isProposalDraft(event.draft),
    isToolOpenProposition: ({ context, event }) =>
      event.type === "OPEN_PROPOSITION" && event.source === "tool" && context.draft !== null,
    isToolQualificationRun: ({ event }) =>
      event.type === "QUALIFICATION_RUN" &&
      event.source === "tool" &&
      event.permissionCleared === true &&
      isNonEmpty(event.permissionEvidence),
    isToolVoteOpenedFirstTime: ({ context }) => context.voteConfig === null,
    isToolVoteOpened: ({ event }) =>
      event.type === "VOTE_OPENED" &&
      event.source === "tool" &&
      event.config.quorum > 0 &&
      (event.config.kind === "standard" || event.config.kind === "criticalSecurity") &&
      event.config.expiryHours === PRODUCT_VOTE_EXPIRY_HOURS[event.config.kind],
    isToolVoteCast: ({ event }) => event.type === "VOTE_CAST" && event.source === "tool" && event.favorable > 0,
    isSystemVoteEvaluateWithQuorum: ({ context, event }) =>
      event.type === "VOTE_EVALUATE" &&
      event.source === "system" &&
      tallyProductVotes(context.favorableVotes, context.voteConfig).quorumReached,
    isToolVoteExpiredWithQuorum: ({ context, event }) =>
      event.type === "VOTE_EXPIRED" &&
      event.source === "tool" &&
      tallyProductVotes(context.favorableVotes, context.voteConfig).quorumReached,
    isToolVoteExpiredWithoutQuorum: ({ context, event }) =>
      event.type === "VOTE_EXPIRED" &&
      event.source === "tool" &&
      !tallyProductVotes(context.favorableVotes, context.voteConfig).quorumReached,
    isToolBudgetCharge: ({ event }) =>
      event.type === "BUDGET_CHARGE" &&
      event.source === "tool" &&
      isNonEmpty(event.action.description) &&
      isNonEmpty(event.action.evidence) &&
      event.action.amount >= 0,
    chargeExhaustsBudget: ({ context, event }) =>
      event.type === "BUDGET_CHARGE" &&
      event.source === "tool" &&
      budgetRemaining(applyBudgetCharge(context.budget, event.action)) <= 0,
    isToolExecutionDone: ({ context, event }) =>
      event.type === "EXECUTION_DONE" && event.source === "tool" && budgetRemaining(context.budget) > 0,
    isToolVerifyRun: ({ event }) =>
      event.type === "VERIFY_RUN" &&
      event.source === "tool" &&
      isNonEmpty(event.control.name) &&
      (event.control.status === "passed" || event.control.status === "failed") &&
      isNonEmpty(event.control.evidence),
    canShip: ({ context }) =>
      canAutoShip({ draft: context.draft, controls: context.controls, budget: context.budget }).allowed &&
      shipGateAnchorsPassed(context.anchors),
    isSystemVerifyEvaluate: ({ event }) => event.type === "VERIFY_EVALUATE" && event.source === "system",
    isToolObservationSample: ({ event }) =>
      event.type === "OBSERVATION_SAMPLE" &&
      event.source === "tool" &&
      ["errors", "aiCost", "latency", "satisfaction"].includes(event.sample.metric) &&
      typeof event.sample.value === "number" &&
      typeof event.sample.threshold === "number" &&
      typeof event.sample.exceeded === "boolean" &&
      isNonEmpty(event.sample.evidence),
    observationDegraded: ({ context, event }) =>
      event.type === "OBSERVATION_EVALUATE" &&
      evaluateObservation(context.observationSamples, event.windowElapsed).confirmed,
    observationClean: ({ context, event }) =>
      event.type === "OBSERVATION_EVALUATE" &&
      context.observationSamples.length >= PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS &&
      !evaluateObservation(context.observationSamples, event.windowElapsed).confirmed &&
      event.windowElapsed,
    isValidExternalAnchor: ({ event }) =>
      event.type === "ANCHOR_RECORDED" &&
      event.source === "tool" &&
      (PRODUCT_EXTERNAL_ANCHORS as readonly string[]).includes(event.anchor) &&
      (event.status === "passed" || event.status === "failed") &&
      isNonEmpty(event.evidence),
    isToolCorrectivePropositionOpened: ({ event }) =>
      event.type === "CORRECTIVE_PROPOSITION_OPENED" && event.source === "tool",
    isHumanReviewResolved: ({ event }) =>
      event.type === "REVIEW_RESOLVED" &&
      event.source === "human" &&
      (event.resolution === "scope-reduced" ||
        event.resolution === "budget-expanded" ||
        event.resolution === "abandoned"),
    isHumanDeployAuthorized: ({ context, event }) =>
      event.type === "REVIEW_RESOLVED" &&
      event.source === "human" &&
      event.resolution === "deploy-authorized" &&
      canHumanAuthorizeSensitiveDeploy({
        draft: context.draft,
        controls: context.controls,
        budget: context.budget,
        anchors: context.anchors,
      }).allowed,
    isHumanRetryVerification: ({ event }) => event.type === "RETRY_VERIFICATION_AUTHORIZED" && event.source === "human",
    isToolContactVoteOpened: ({ event }) => event.type === "CONTACT_VOTE_OPENED" && event.source === "tool",
    isToolContactVoteQuorum: ({ event }) =>
      event.type === "CONTACT_VOTE_QUORUM" && event.source === "tool" && typeof event.reached === "boolean",
    isHumanContactRelayAuthorized: ({ context, event }) =>
      event.type === "CONTACT_RELAY_AUTHORIZED" &&
      event.source === "human" &&
      context.contactVoteQuorumReached === true,
    isToolPermissionDenial: ({ event }) =>
      event.type === "PERMISSION_DENIED" && event.source === "tool" && isNonEmpty(event.reason),
    isHumanCancellation: ({ event }) => event.type === "CANCEL" && event.source === "human" && isNonEmpty(event.reason),
  },
  actions: {
    recordDraft: assign(({ context, event }) =>
      event.type === "PROPOSAL_DRAFTED" ? { ...context, draft: event.draft } : context,
    ),
    recordSignal: assign(({ context, event }) => {
      // Signal-only events (AGENT_SIGNAL, FEEDBACK_AGGREGATED) carry no state
      // target; they are recorded as traceable product signal evidence so the
      // persisted snapshot reflects that the machine accepted them. This keeps
      // feedback/signal history queryable and makes acceptance observable to the
      // journal-based runner without coupling it to guard internals.
      if (event.type !== "AGENT_SIGNAL" && event.type !== "FEEDBACK_AGGREGATED") return context;
      const entry =
        event.type === "AGENT_SIGNAL" ? `agent-signal: ${event.note}` : `feedback-aggregated: ${event.summary}`;
      return { ...context, signalLog: [...context.signalLog, entry] };
    }),
    recordPermission: assign(({ context, event }) =>
      event.type === "QUALIFICATION_RUN"
        ? {
            ...context,
            permissionsCleared: event.permissionCleared,
            permissionEvidence: event.permissionEvidence,
          }
        : context,
    ),
    sealQualificationPassed: assign(({ context }) => ({
      ...context,
      anchors: {
        ...context.anchors,
        "qualification-passed": {
          status: "passed",
          evidence: `qualifier: scope, dependencies, category, permissions, budget validated (${context.permissionEvidence ?? "none"})`,
        },
      },
    })),
    recordVoteConfig: assign(({ context, event }) =>
      event.type === "VOTE_OPENED" ? { ...context, voteConfig: event.config, favorableVotes: 0 } : context,
    ),
    recordVote: assign(({ context, event }) =>
      event.type === "VOTE_CAST" ? { ...context, favorableVotes: context.favorableVotes + event.favorable } : context,
    ),
    sealVoteQuorum: assign(({ context }) => ({
      ...context,
      anchors: {
        ...context.anchors,
        "vote-quorum": {
          status: "passed",
          evidence: `quorum ${context.voteConfig?.quorum} reached with ${context.favorableVotes} favorable`,
        },
      },
    })),
    openBudget: assign(({ context }) => {
      const allocation = context.draft?.budgetAllocation ?? 0;
      return {
        ...context,
        budget: { initial: allocation, consumed: 0, history: [] },
        anchors: {
          ...context.anchors,
          "budget-envelope": { status: "passed", evidence: `envelope opened at ${allocation}` },
        },
      };
    }),
    chargeBudget: assign(({ context, event }) => {
      if (event.type !== "BUDGET_CHARGE") return context;
      return { ...context, budget: applyBudgetCharge(context.budget, event.action) };
    }),
    recordControl: assign(({ context, event }) => {
      if (event.type !== "VERIFY_RUN") return context;
      return { ...context, controls: { ...context.controls, [event.control.name]: event.control } };
    }),
    sealVerificationAnchors: assign(({ context }) => {
      const decision = canAutoShip({ draft: context.draft, controls: context.controls, budget: context.budget });
      return {
        ...context,
        anchors: {
          ...context.anchors,
          "controls-passed": {
            status: "passed",
            evidence: `${Object.keys(context.controls).length} controls passed`,
          },
          "auto-ship-policy": {
            status: decision.allowed ? "passed" : "failed",
            evidence: decision.reason,
          },
          // NOTE: `rollback-path-exists` is NOT sealed here. It is an external
          // anchor recorded by the verifier tool (product:anchors) via
          // ANCHOR_RECORDED after the rollback artifact is confirmed genuine.
        },
      };
    }),
    sealHumanAuthorizedDeploy: assign(({ context }) => ({
      ...context,
      anchors: {
        ...context.anchors,
        "controls-passed": {
          status: "passed",
          evidence: `${Object.keys(context.controls).length} controls passed (human deploy review)`,
        },
        "auto-ship-policy": {
          status: "passed",
          evidence: "sensitive change deploy authorized by human owner review; auto-ship does not apply",
        },
      },
    })),
    recordObservationSample: assign(({ context, event }) => {
      if (event.type !== "OBSERVATION_SAMPLE") return context;
      // Satisfaction is recorded as signal only; it can never confirm degradation.
      return { ...context, observationSamples: [...context.observationSamples, event.sample] };
    }),
    sealObservationWindow: assign(({ context }) => ({
      ...context,
      anchors: {
        ...context.anchors,
        "observation-window": {
          status: "passed",
          evidence: `${context.observationSamples.length} samples recorded`,
        },
      },
    })),
    recordExternalAnchorOnce: assign(({ context, event }) => {
      if (event.type !== "ANCHOR_RECORDED") return context;
      if (context.anchors[event.anchor] !== undefined) return context; // failed anchors are immutable per run
      return {
        ...context,
        anchors: {
          ...context.anchors,
          [event.anchor]: { status: event.status, evidence: event.evidence },
        },
      };
    }),
    prepareCorrectiveProposition: assign(({ context }) => ({
      ...context,
      // A corrective/re-scope proposal starts fresh in proposition; prior
      // attempt-scoped evidence is cleared. Draft must be re-submitted and
      // re-qualified; no anchor carries over.
      draft: null,
      voteConfig: null,
      favorableVotes: 0,
      controls: {},
      observationSamples: [],
      anchors: {},
    })),
    recordReviewResolution: assign(({ context }) => ({ ...context })),
    recordBudgetBlockedEntry: assign(({ context }) => ({
      ...context,
      reviewReason: "budget-exhausted",
    })),
    expandBudget: assign(({ context, event }) => {
      if (event.type !== "REVIEW_RESOLVED" || typeof event.expandedBudget !== "number") return context;
      const consumed = context.budget?.consumed ?? 0;
      const initial = Math.max(event.expandedBudget, consumed);
      return {
        ...context,
        budget: context.budget ? { ...context.budget, initial } : { initial, consumed: 0, history: [] },
      };
    }),
    resetControlsForRetry: assign(({ context }) => ({
      ...context,
      controls: {},
      anchors: { ...context.anchors },
    })),
    recordContactVoteOpened: assign(({ context }) => ({ ...context, contactVoteOpen: true })),
    recordContactVoteQuorum: assign(({ context, event }) =>
      event.type === "CONTACT_VOTE_QUORUM" ? { ...context, contactVoteQuorumReached: event.reached } : context,
    ),
    recordContactRelay: assign(({ context }) => ({ ...context, contactRelayAuthorized: true })),
    recordTerminalRejected: assign(({ context }) => ({
      ...context,
      terminalReason: "vote expired without quorum",
    })),
    recordTerminalCancelled: assign(({ context }) => ({
      ...context,
      terminalReason: "run cancelled by owner",
    })),
    recordTerminalValidated: assign(({ context }) => ({
      ...context,
      terminalReason: "observation completed without confirmed degradation",
    })),
  },
});

export const productMachine = productSetup.createMachine({
  id: "swarm-dao-product-loop",
  initial: "exploration",
  context: ({ input }) => initialContext(input),
  on: {
    PERMISSION_DENIED: { guard: "isToolPermissionDenial", target: ".review" },
    CANCEL: { guard: "isHumanCancellation", target: ".rejected", actions: "recordTerminalCancelled" },
    CONTACT_VOTE_OPENED: { guard: "isToolContactVoteOpened", actions: "recordContactVoteOpened" },
    CONTACT_VOTE_QUORUM: { guard: "isToolContactVoteQuorum", actions: "recordContactVoteQuorum" },
    CONTACT_RELAY_AUTHORIZED: {
      guard: "isHumanContactRelayAuthorized",
      actions: "recordContactRelay",
    },
    // NOTE: ANCHOR_RECORDED is intentionally NOT global. External anchors
    // (frozen-set-intact, regression, rollback-path-exists) are only meaningful
    // and only accepted while the machine is in the `verification` state, where
    // the verifier tool records them. Accepting them globally would let a
    // verifier seal regression/frozen-set before any implementation exists.
  },
  states: {
    exploration: {
      on: {
        AGENT_SIGNAL: { guard: "isAiAgentSignal", actions: "recordSignal" },
        FEEDBACK_AGGREGATED: { guard: "isAiFeedbackAggregated", actions: "recordSignal" },
        PROPOSAL_DRAFTED: { guard: "isAiProposalDrafted", actions: "recordDraft" },
        OPEN_PROPOSITION: { guard: "isToolOpenProposition", target: "proposition" },
      },
    },
    proposition: {
      on: {
        // A corrective/re-scope flow clears the draft on entry to proposition
        // (prepareCorrectiveProposition). The replacement draft must be recorded
        // here before qualification can run, exactly as in exploration.
        PROPOSAL_DRAFTED: { guard: "isAiProposalDrafted", actions: "recordDraft" },
        QUALIFICATION_RUN: {
          guard: "isToolQualificationRun",
          target: "qualification",
          actions: "recordPermission",
        },
      },
    },
    qualification: {
      always: [
        {
          guard: ({ context }) => qualifyProposal(context.draft, context.permissionsCleared).qualified,
          target: "vote",
          actions: "sealQualificationPassed",
        },
        { target: "review" },
      ],
    },
    vote: {
      on: {
        VOTE_OPENED: {
          guard: ({ context, event }) =>
            context.voteConfig === null &&
            event.type === "VOTE_OPENED" &&
            event.source === "tool" &&
            event.config.quorum > 0 &&
            (event.config.kind === "standard" || event.config.kind === "criticalSecurity") &&
            event.config.expiryHours === PRODUCT_VOTE_EXPIRY_HOURS[event.config.kind],
          actions: "recordVoteConfig",
        },
        VOTE_CAST: { guard: "isToolVoteCast", actions: "recordVote" },
        VOTE_EVALUATE: {
          guard: "isSystemVoteEvaluateWithQuorum",
          target: "adopted",
          actions: "sealVoteQuorum",
        },
        // Expiry is deterministic: if quorum was already reached when the expiry
        // event arrives, the task is adopted (and the quorum anchor sealed); only
        // expiry WITHOUT quorum rejects. This prevents a late expiry from killing
        // an already-quorate task whose EVALUATE had not yet been emitted.
        VOTE_EXPIRED: [
          {
            guard: "isToolVoteExpiredWithQuorum",
            target: "adopted",
            actions: "sealVoteQuorum",
          },
          {
            guard: "isToolVoteExpiredWithoutQuorum",
            target: "rejected",
            actions: "recordTerminalRejected",
          },
        ],
      },
    },
    adopted: {
      always: [{ target: "execution", actions: "openBudget" }],
    },
    execution: {
      on: {
        BUDGET_CHARGE: [
          {
            guard: "chargeExhaustsBudget",
            target: "budgetBlocked",
            actions: "chargeBudget",
          },
          { guard: "isToolBudgetCharge", actions: "chargeBudget" },
        ],
        EXECUTION_DONE: { guard: "isToolExecutionDone", target: "verification" },
      },
    },
    budgetBlocked: {
      // Budget exhaustion has only one deterministic escape: escalate to human
      // review. This is a model-mandated transition (not an agent decision): no
      // contributor swap, retry, or bypass may skip review. The human owner then
      // resolves via REVIEW_RESOLVED (expand budget / reduce scope / abandon) in
      // the review state. The `always` makes the escalation immediate so the
      // persisted snapshot records the budget block as the cause entering review.
      always: [{ target: "review", actions: "recordBudgetBlockedEntry" }],
    },
    verification: {
      on: {
        VERIFY_RUN: { guard: "isToolVerifyRun", actions: "recordControl" },
        // External anchors (frozen-set-intact, regression, rollback-path-exists)
        // are recorded ONLY in verification by the verifier tool. `rollback-path-
        // exists` is a ship-gate prerequisite, so it must be recorded before
        // VERIFY_EVALUATE selects ship.
        ANCHOR_RECORDED: { guard: "isValidExternalAnchor", actions: "recordExternalAnchorOnce" },
        VERIFY_EVALUATE: [
          {
            guard: ({ context, event }) =>
              event.type === "VERIFY_EVALUATE" &&
              event.source === "system" &&
              canAutoShip({ draft: context.draft, controls: context.controls, budget: context.budget }).allowed &&
              shipGateAnchorsPassed(context.anchors),
            target: "ship",
            actions: "sealVerificationAnchors",
          },
          {
            guard: "isSystemVerifyEvaluate",
            target: "review",
            actions: "sealVerificationAnchors",
          },
        ],
      },
    },
    ship: {
      always: [{ target: "observation" }],
    },
    observation: {
      on: {
        OBSERVATION_SAMPLE: { guard: "isToolObservationSample", actions: "recordObservationSample" },
        OBSERVATION_EVALUATE: [
          {
            guard: "observationDegraded",
            target: "rollback",
          },
          {
            guard: "observationClean",
            target: "validated",
            actions: ["sealObservationWindow", "recordTerminalValidated"],
          },
        ],
      },
    },
    rollback: {
      on: {
        CORRECTIVE_PROPOSITION_OPENED: {
          guard: "isToolCorrectivePropositionOpened",
          target: "proposition",
          actions: "prepareCorrectiveProposition",
        },
      },
    },
    review: {
      on: {
        REVIEW_RESOLVED: [
          {
            guard: ({ event }) =>
              event.type === "REVIEW_RESOLVED" && event.source === "human" && event.resolution === "scope-reduced",
            target: "proposition",
            actions: "prepareCorrectiveProposition",
          },
          {
            // Budget expansion is the ONLY escape from BudgetBlocked, and only
            // when the review was actually entered because of budget exhaustion.
            // This prevents any other review cause (qualification failure,
            // permission denial, verification failure) from using budget-expanded
            // to jump straight to execution, bypassing qualification and vote. The
            // human review must declare a strictly larger envelope than what has
            // already been consumed; otherwise the task would immediately
            // re-block. Consumed spend and history are preserved.
            guard: ({ context, event }) =>
              event.type === "REVIEW_RESOLVED" &&
              event.source === "human" &&
              event.resolution === "budget-expanded" &&
              context.reviewReason === "budget-exhausted" &&
              typeof event.expandedBudget === "number" &&
              Number.isFinite(event.expandedBudget) &&
              event.expandedBudget > (context.budget?.consumed ?? 0),
            target: "execution",
            actions: "expandBudget",
          },
          {
            // Human deploy-authorization: the ONLY path to ship for sensitive
            // changes (security/permissions/secrets/payments/sensitive-data) that
            // passed verification but are forbidden from auto-ship. The
            // isHumanDeployAuthorized guard re-checks controls, budget, and the
            // ship-gate anchors (including the externally verified rollback
            // path). No AI source may emit this.
            guard: "isHumanDeployAuthorized",
            target: "ship",
            actions: "sealHumanAuthorizedDeploy",
          },
          {
            guard: ({ event }) =>
              event.type === "REVIEW_RESOLVED" && event.source === "human" && event.resolution === "abandoned",
            target: "rejected",
            actions: "recordReviewResolution",
          },
        ],
        RETRY_VERIFICATION_AUTHORIZED: {
          guard: "isHumanRetryVerification",
          target: "verification",
          actions: "resetControlsForRetry",
        },
      },
    },
    validated: { type: "final" },
    rejected: { type: "final" },
  },
});

export type ProductActor = ActorRefFrom<typeof productMachine>;

export const createProductActor = (input: ProductMachineInput): ProductActor => {
  const actor = createActor(productMachine, { input });
  actor.start();
  return actor;
};
