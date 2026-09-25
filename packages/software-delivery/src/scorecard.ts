import { PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS } from "@guyghost/swarm-dao-core";

export type DeliveryScorecardJournal = "delivery" | "product" | "graph";

export type DeliveryScorecardEntry = Readonly<{
  deliveryRunId: string;
  journal: DeliveryScorecardJournal;
  kind?: string;
  eventType?: string | null;
  accepted?: boolean;
  source?: string;
  receivedAt?: string;
  afterState?: string;
  payload?: Readonly<Record<string, unknown>>;
  signal?: Readonly<{
    type?: string;
    source?: string;
    payload?: Readonly<Record<string, unknown>>;
  }>;
  snapshot?: Readonly<{
    state?: string;
    status?: string;
    context?: Readonly<Record<string, unknown>>;
  }>;
}>;

export type DeliveryScorecardRate = Readonly<{
  numerator: number;
  denominator: number;
  rate: number | null;
}>;

export type DeliveryScorecard = Readonly<{
  generatedAt: string;
  since: string | null;
  totalRuns: number;
  terminalRuns: number;
  outcomes: Readonly<Record<"validated" | "rolledBack" | "failed" | "blocked" | "cancelled" | "rejected", number>>;
  completion: DeliveryScorecardRate;
  postApprovalAutonomy: DeliveryScorecardRate;
  rollback: DeliveryScorecardRate;
  humanIntervention: Readonly<{ count: number; denominator: number; rate: number | null }>;
  retries: Readonly<{ runs: number; total: number }>;
  failedControls: number;
  activeRuns: number;
  incompleteObservationRuns: number;
  unknownInitialRiskRuns: number;
  unavailableData: Readonly<{
    initialRiskRuns: number;
    optionalCostRuns: number;
    approvalTimelineRuns: number;
  }>;
  latencyP95Ms: number | null;
}>;

const TERMINAL_OUTCOMES = ["validated", "rolledBack", "failed", "blocked", "cancelled", "rejected"] as const;
type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];
type RunData = {
  entries: DeliveryScorecardEntry[];
  deliverySnapshot?: DeliveryScorecardEntry["snapshot"];
  graphSnapshot?: DeliveryScorecardEntry["snapshot"];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsedTime = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const eventOf = (
  entry: DeliveryScorecardEntry,
): { type: string | null; source: string | null; payload: Record<string, unknown> } => {
  const signal = isRecord(entry.signal) ? entry.signal : null;
  return {
    type: typeof signal?.type === "string" ? signal.type : typeof entry.eventType === "string" ? entry.eventType : null,
    source: typeof signal?.source === "string" ? signal.source : typeof entry.source === "string" ? entry.source : null,
    payload: isRecord(signal?.payload) ? signal.payload : isRecord(entry.payload) ? entry.payload : {},
  };
};

const contextOf = (snapshot: DeliveryScorecardEntry["snapshot"]): Record<string, unknown> =>
  isRecord(snapshot?.context) ? snapshot.context : {};

const isTerminalOutcome = (value: unknown): value is TerminalOutcome =>
  typeof value === "string" && (TERMINAL_OUTCOMES as readonly string[]).includes(value);

const rate = (numerator: number, denominator: number): DeliveryScorecardRate => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
});

const percentile95 = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = Math.ceil(0.95 * sorted.length);
  return sorted[nearestRank - 1] ?? null;
};

/** Reduce delivery and child journal evidence into anonymous aggregate metrics. */
export const buildDeliveryScorecard = (
  entries: readonly DeliveryScorecardEntry[],
  options: Readonly<{ now: string; since?: string }>,
): DeliveryScorecard => {
  const now = parsedTime(options.now);
  const since = options.since === undefined ? null : parsedTime(options.since);
  if (now === null) throw new Error("scorecard now must be a valid timestamp");
  if (options.since !== undefined && since === null) throw new Error("scorecard since must be a valid timestamp");

  const grouped = new Map<string, RunData>();
  for (const entry of entries) {
    if (!entry || typeof entry.deliveryRunId !== "string" || entry.deliveryRunId.length === 0) continue;
    const timestamp = parsedTime(entry.receivedAt);
    if (since !== null && timestamp !== null && timestamp < since) continue;
    if (since !== null && timestamp === null) continue;
    let run = grouped.get(entry.deliveryRunId);
    if (!run) {
      run = { entries: [] };
      grouped.set(entry.deliveryRunId, run);
    }
    run.entries.push(entry);
    if (entry.journal === "delivery" && entry.kind === "snapshot") run.deliverySnapshot = entry.snapshot;
    if (entry.journal === "graph" && entry.kind === "snapshot") run.graphSnapshot = entry.snapshot;
  }

  // If a since filter is requested, include only runs whose earliest delivery
  // evidence is in the requested window; avoid scoring a partial older run.
  if (since !== null) {
    for (const [runId, run] of grouped) {
      const deliveryTimes = run.entries
        .filter((entry) => entry.journal === "delivery")
        .map((entry) => parsedTime(entry.receivedAt))
        .filter((value): value is number => value !== null);
      if (deliveryTimes.length > 0 && Math.min(...deliveryTimes) < since) grouped.delete(runId);
    }
  }

  const outcomes: Record<TerminalOutcome, number> = {
    validated: 0,
    rolledBack: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    rejected: 0,
  };
  let terminalRuns = 0;
  let activeRuns = 0;
  let unknownInitialRiskRuns = 0;
  let incompleteObservationRuns = 0;
  let failedControls = 0;
  let retryTotal = 0;
  let retryRuns = 0;
  let observationTerminalApprovedRuns = 0;
  let autonomousValidatedRuns = 0;
  let humanInterventionRuns = 0;
  let approvalTimelineRunsUnavailable = 0;
  let optionalCostUnavailableRuns = 0;
  const latencies: number[] = [];

  for (const run of grouped.values()) {
    const delivery = run.deliverySnapshot;
    const deliveryContext = contextOf(delivery);
    const state = delivery?.state ?? "unknown";
    const outcome = isTerminalOutcome(deliveryContext.outcome)
      ? deliveryContext.outcome
      : isTerminalOutcome(state)
        ? state
        : null;
    const initialRisk = deliveryContext.initialRiskClass;
    if (initialRisk === "unknown" || (initialRisk !== "standard" && initialRisk !== "sensitive")) {
      unknownInitialRiskRuns += 1;
    }
    if (outcome !== null) {
      terminalRuns += 1;
      outcomes[outcome] += 1;
    } else {
      activeRuns += 1;
    }
    if (state === "observing") incompleteObservationRuns += 1;

    const graphAttempt = run.graphSnapshot?.context?.attempt;
    const attempts =
      typeof graphAttempt === "number" && Number.isSafeInteger(graphAttempt) ? Math.max(0, graphAttempt) : 0;
    if (attempts > 0) retryRuns += 1;
    retryTotal += attempts;

    const approvalSignals = run.entries
      .filter((entry) => entry.journal === "graph" && entry.accepted !== false)
      .filter((entry) => {
        const event = eventOf(entry);
        return event.type === "MODEL_APPROVED" && event.source === "human";
      });
    const modelHash = deliveryContext.modelHash;
    const approvedModelHash = deliveryContext.approvedModelHash;
    const exactApproval = approvalSignals.find((entry) => {
      const payload = eventOf(entry).payload;
      return typeof modelHash === "string" && modelHash === approvedModelHash && payload.modelHash === modelHash;
    });
    if (exactApproval) {
      const approvalTime = parsedTime(exactApproval.receivedAt);
      if (outcome === "validated" || outcome === "rolledBack") {
        observationTerminalApprovedRuns += 1;
        if (approvalTime === null) {
          approvalTimelineRunsUnavailable += 1;
        } else {
          const postApprovalHumanAction = run.entries.some((entry) => {
            if (entry.accepted === false) return false;
            const event = eventOf(entry);
            if (event.source !== "human" || event.type === "MODEL_APPROVED") return false;
            const eventTime = parsedTime(entry.receivedAt);
            return eventTime !== null && eventTime > approvalTime;
          });
          if (postApprovalHumanAction) humanInterventionRuns += 1;
          if (outcome === "validated" && !postApprovalHumanAction) autonomousValidatedRuns += 1;
        }
      }
    }

    const productEntries = run.entries.filter((entry) => entry.journal === "product" && entry.accepted !== false);
    for (const entry of productEntries) {
      const event = eventOf(entry);
      if (event.type === "VERIFY_RUN") {
        const control = event.payload.control;
        if (isRecord(control) && control.status === "failed") failedControls += 1;
      }
      if (event.type === "OBSERVATION_SAMPLE") {
        const sample = event.payload.sample;
        if (
          isRecord(sample) &&
          sample.metric === "latency" &&
          typeof sample.value === "number" &&
          Number.isFinite(sample.value)
        ) {
          latencies.push(sample.value);
        }
      }
    }

    const reachedObservation = state === "observing" || outcome === "validated" || outcome === "rolledBack";
    const optionalCostMeasurements = productEntries.filter((entry) => {
      const event = eventOf(entry);
      const sample = event.payload.sample;
      return event.type === "OBSERVATION_SAMPLE" && isRecord(sample) && sample.metric === "aiCost";
    }).length;
    if (reachedObservation && optionalCostMeasurements < PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS) {
      optionalCostUnavailableRuns += 1;
    }
  }

  return {
    generatedAt: options.now,
    since: options.since ?? null,
    totalRuns: grouped.size,
    terminalRuns,
    outcomes,
    completion: rate(outcomes.validated, terminalRuns),
    postApprovalAutonomy: rate(autonomousValidatedRuns, observationTerminalApprovedRuns),
    rollback: rate(outcomes.rolledBack, outcomes.validated + outcomes.rolledBack),
    humanIntervention: {
      count: humanInterventionRuns,
      denominator: observationTerminalApprovedRuns,
      rate: rate(humanInterventionRuns, observationTerminalApprovedRuns).rate,
    },
    retries: { runs: retryRuns, total: retryTotal },
    failedControls,
    activeRuns,
    incompleteObservationRuns,
    unknownInitialRiskRuns,
    unavailableData: {
      initialRiskRuns: unknownInitialRiskRuns,
      optionalCostRuns: optionalCostUnavailableRuns,
      approvalTimelineRuns: approvalTimelineRunsUnavailable,
    },
    latencyP95Ms: percentile95(latencies),
  };
};
