import {
  type ObservationMetric,
  type ObservationSample,
  PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS,
} from "@guyghost/swarm-dao-core";

export type StagingObservationInspection = Readonly<{
  intact: boolean;
  errorCount: number;
  checkLatencyMs: number;
  evidence: string;
}>;

export type OptionalObservationMeasurement =
  | Readonly<{ available: false }>
  | Readonly<{ available: true; value: number; threshold: number; evidence: string }>;

export type StagingObservationOptions = Readonly<{
  inspect: () => Promise<StagingObservationInspection>;
  providerCost?: OptionalObservationMeasurement;
  customerSignal?: OptionalObservationMeasurement;
  thresholds?: Readonly<{ errors: number; latencyMs: number }>;
}>;

export type StagingObservationGate =
  | Readonly<{ status: "collecting" }>
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "degraded"; metric: "errors" | "aiCost" | "latency" }>;

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const validNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const metricSample = (
  metric: ObservationMetric,
  value: number,
  threshold: number,
  exceeded: boolean,
  evidence: string,
): ObservationSample => ({ metric, value, threshold, exceeded, evidence });

export const createStagingObservationSamples = async (
  options: StagingObservationOptions,
): Promise<readonly ObservationSample[]> => {
  const measured = await options.inspect();
  if (
    !measured ||
    typeof measured.intact !== "boolean" ||
    !validNonNegative(measured.errorCount) ||
    !validNonNegative(measured.checkLatencyMs) ||
    !nonEmptyString(measured.evidence)
  ) {
    throw new Error("staging inspection must return actual error, latency, integrity, and evidence measurements");
  }

  const thresholds = options.thresholds ?? { errors: 0, latencyMs: 1_000 };
  if (!validNonNegative(thresholds.errors) || !validNonNegative(thresholds.latencyMs)) {
    throw new Error("staging observation thresholds must be finite non-negative numbers");
  }

  const actualErrors = measured.intact ? measured.errorCount : Math.max(1, measured.errorCount);
  const samples: ObservationSample[] = [
    metricSample("errors", actualErrors, thresholds.errors, actualErrors > thresholds.errors, measured.evidence),
    metricSample(
      "latency",
      measured.checkLatencyMs,
      thresholds.latencyMs,
      measured.checkLatencyMs > thresholds.latencyMs,
      measured.evidence,
    ),
  ];

  const providerCost = options.providerCost;
  if (
    providerCost?.available &&
    validNonNegative(providerCost.value) &&
    validNonNegative(providerCost.threshold) &&
    nonEmptyString(providerCost.evidence)
  ) {
    samples.push(
      metricSample(
        "aiCost",
        providerCost.value,
        providerCost.threshold,
        providerCost.value > providerCost.threshold,
        providerCost.evidence,
      ),
    );
  }

  const customerSignal = options.customerSignal;
  if (
    customerSignal?.available &&
    Number.isFinite(customerSignal.value) &&
    Number.isFinite(customerSignal.threshold) &&
    nonEmptyString(customerSignal.evidence)
  ) {
    samples.push(
      metricSample(
        "satisfaction",
        customerSignal.value,
        customerSignal.threshold,
        customerSignal.value < customerSignal.threshold,
        customerSignal.evidence,
      ),
    );
  }

  return samples;
};

const LAST_MEASUREMENT_PRIORITY: readonly ("errors" | "aiCost" | "latency")[] = ["errors", "aiCost", "latency"];

export const evaluateStagingObservation = (
  samples: readonly ObservationSample[],
  options: Readonly<{ windowElapsed: boolean }>,
): StagingObservationGate => {
  for (const metric of LAST_MEASUREMENT_PRIORITY) {
    const measurements = samples.filter((sample) => sample.metric === metric);
    if (measurements.length < PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS) continue;
    const tail = measurements.slice(-PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS);
    if (tail.every((sample) => sample.exceeded)) return { status: "degraded", metric };
  }

  if (!options.windowElapsed) return { status: "collecting" };
  const requiredMetrics = ["errors", "latency"] as const;
  const enoughCleanMeasurements = requiredMetrics.every((metric) => {
    const measurements = samples.filter((sample) => sample.metric === metric);
    if (measurements.length < PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS) return false;
    return measurements.slice(-PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS).every((sample) => !sample.exceeded);
  });
  return enoughCleanMeasurements ? { status: "ready" } : { status: "collecting" };
};
