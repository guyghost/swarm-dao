// ============================================================
// Swarm DAO Core — Metrics Collection
// ============================================================

export interface MetricValue {
  name: string;
  value: number;
  timestamp: string;
  labels?: Record<string, string>;
}

function matchesLabels(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (!b) return true;
  if (!a) return false;
  return Object.entries(b).every(([k, v]) => a[k] === v);
}

export interface Counter {
  name: string;
  description: string;
  values: MetricValue[];
  increment(labels?: Record<string, string>): void;
  getCount(labels?: Record<string, string>): number;
}

export interface Gauge {
  name: string;
  description: string;
  values: MetricValue[];
  set(value: number, labels?: Record<string, string>): void;
  getValue(labels?: Record<string, string>): number;
}

export interface Histogram {
  name: string;
  description: string;
  buckets: number[];
  values: MetricValue[];
  observe(value: number, labels?: Record<string, string>): void;
  getPercentile(p: number, labels?: Record<string, string>): number;
  getCount(labels?: Record<string, string>): number;
  getBucketCounts(labels?: Record<string, string>): Record<string, number>;
}

class CounterImpl implements Counter {
  values: MetricValue[] = [];
  constructor(public name: string, public description: string) {}

  increment(labels?: Record<string, string>): void {
    this.values.push({
      name: this.name,
      value: 1,
      timestamp: new Date().toISOString(),
      labels,
    });
  }

  getCount(labels?: Record<string, string>): number {
    return this.values.filter((v) => matchesLabels(v.labels, labels)).length;
  }

}

class GaugeImpl implements Gauge {
  values: MetricValue[] = [];
  constructor(public name: string, public description: string) {}

  set(value: number, labels?: Record<string, string>): void {
    this.values.push({
      name: this.name,
      value,
      timestamp: new Date().toISOString(),
      labels,
    });
  }

  getValue(labels?: Record<string, string>): number {
    const matching = this.values.filter((v) => matchesLabels(v.labels, labels));
    return matching.length > 0 ? matching[matching.length - 1]!.value : 0;
  }

}

class HistogramImpl implements Histogram {
  values: MetricValue[] = [];
  constructor(public name: string, public description: string, public buckets: number[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) {}

  observe(value: number, labels?: Record<string, string>): void {
    this.values.push({
      name: this.name,
      value,
      timestamp: new Date().toISOString(),
      labels,
    });
  }

  getCount(labels?: Record<string, string>): number {
    return this.values.filter((v) => matchesLabels(v.labels, labels)).length;
  }

  getPercentile(p: number, labels?: Record<string, string>): number {
    const matching = this.values
      .filter((v) => matchesLabels(v.labels, labels))
      .map((v) => v.value)
      .sort((a, b) => a - b);
    if (matching.length === 0) return 0;
    const index = Math.max(0, Math.ceil((p / 100) * matching.length) - 1);
    return matching[index] ?? 0;
  }

  getBucketCounts(labels?: Record<string, string>): Record<string, number> {
    const matching = this.values.filter((v) => matchesLabels(v.labels, labels)).map((v) => v.value);
    const counts: Record<string, number> = {};
    for (const bucket of this.buckets) {
      counts[`le_${bucket}`] = matching.filter((v) => v <= bucket).length;
    }
    counts["+Inf"] = matching.length;
    return counts;
  }

}

// ── Registry ─────────────────────────────────────────────────

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();
const histograms = new Map<string, Histogram>();

export function createCounter(name: string, description: string): Counter {
  const counter = new CounterImpl(name, description);
  counters.set(name, counter);
  return counter;
}

export function createGauge(name: string, description: string): Gauge {
  const gauge = new GaugeImpl(name, description);
  gauges.set(name, gauge);
  return gauge;
}

export function createHistogram(name: string, description: string, buckets?: number[]): Histogram {
  const histogram = new HistogramImpl(name, description, buckets);
  histograms.set(name, histogram);
  return histogram;
}

export function getCounter(name: string): Counter | undefined {
  return counters.get(name);
}

export function getGauge(name: string): Gauge | undefined {
  return gauges.get(name);
}

export function getHistogram(name: string): Histogram | undefined {
  return histograms.get(name);
}

export function getAllMetrics(): { counters: Counter[]; gauges: Gauge[]; histograms: Histogram[] } {
  return {
    counters: Array.from(counters.values()),
    gauges: Array.from(gauges.values()),
    histograms: Array.from(histograms.values()),
  };
}

export function resetMetrics(): void {
  for (const counter of counters.values()) {
    counter.values = [];
  }
  for (const gauge of gauges.values()) {
    gauge.values = [];
  }
  for (const histogram of histograms.values()) {
    histogram.values = [];
  }
}

// ── DAO Metrics ──────────────────────────────────────────────

export const DAO_METRICS = {
  proposalsCreated: createCounter("dao_proposals_created", "Total proposals created"),
  proposalsApproved: createCounter("dao_proposals_approved", "Total proposals approved"),
  proposalsRejected: createCounter("dao_proposals_rejected", "Total proposals rejected"),
  proposalsExecuted: createCounter("dao_proposals_executed", "Total proposals executed"),
  votesCast: createCounter("dao_votes_cast", "Total votes cast by agents"),
  deliberationDuration: createHistogram("dao_deliberation_duration_ms", "Deliberation duration in milliseconds"),
  agentResponseTime: createHistogram("dao_agent_response_time_ms", "Agent response time in milliseconds"),
  activeProposals: createGauge("dao_active_proposals", "Number of currently open proposals"),
  agentCount: createGauge("dao_agent_count", "Number of active agents"),
  approvalRate: createGauge("dao_approval_rate_percent", "Current approval rate percentage"),
};

export function recordProposalCreated(type: string): void {
  DAO_METRICS.proposalsCreated.increment({ type });
  DAO_METRICS.activeProposals.set(
    DAO_METRICS.proposalsCreated.getCount() -
      DAO_METRICS.proposalsApproved.getCount() -
      DAO_METRICS.proposalsRejected.getCount(),
  );
}

export function recordProposalApproved(id: number, type: string): void {
  DAO_METRICS.proposalsApproved.increment({ type });
  updateApprovalRate();
}

export function recordProposalRejected(id: number, type: string): void {
  DAO_METRICS.proposalsRejected.increment({ type });
  updateApprovalRate();
}

export function recordProposalExecuted(id: number, type: string): void {
  DAO_METRICS.proposalsExecuted.increment({ type });
  DAO_METRICS.activeProposals.set(
    Math.max(0, DAO_METRICS.activeProposals.getValue() - 1),
  );
}

export function recordVoteCast(agentId: string, position: string, weight: number): void {
  DAO_METRICS.votesCast.increment({ agent: agentId, position, weight: String(weight) });
}

export function recordDeliberationDuration(durationMs: number, proposalId: number): void {
  DAO_METRICS.deliberationDuration.observe(durationMs, { proposal_id: String(proposalId) });
}

export function recordAgentResponseTime(durationMs: number, agentId: string): void {
  DAO_METRICS.agentResponseTime.observe(durationMs, { agent: agentId });
}

function updateApprovalRate(): void {
  const approved = DAO_METRICS.proposalsApproved.getCount();
  const rejected = DAO_METRICS.proposalsRejected.getCount();
  const total = approved + rejected;
  DAO_METRICS.approvalRate.set(total > 0 ? Math.round((approved / total) * 100) : 0);
}

export function formatMetrics(): string {
  const all = getAllMetrics();
  let output = "# DAO Metrics\n\n";

  for (const counter of all.counters) {
    output += `## ${counter.name}\n${counter.description}\n**Total:** ${counter.getCount()}\n\n`;
  }

  for (const gauge of all.gauges) {
    output += `## ${gauge.name}\n${gauge.description}\n**Value:** ${gauge.getValue()}\n\n`;
  }

  for (const histogram of all.histograms) {
    output += `## ${histogram.name}\n${histogram.description}\n**Count:** ${histogram.getCount()}\n**P50:** ${histogram.getPercentile(50)}\n**P95:** ${histogram.getPercentile(95)}\n**P99:** ${histogram.getPercentile(99)}\n\n`;
  }

  return output;
}

export function formatMetricsPrometheus(): string {
  const all = getAllMetrics();
  let output = "";

  for (const counter of all.counters) {
    output += `# HELP ${counter.name} ${counter.description}\n`;
    output += `# TYPE ${counter.name} counter\n`;
    output += `${counter.name} ${counter.getCount()}\n\n`;
  }

  for (const gauge of all.gauges) {
    output += `# HELP ${gauge.name} ${gauge.description}\n`;
    output += `# TYPE ${gauge.name} gauge\n`;
    output += `${gauge.name} ${gauge.getValue()}\n\n`;
  }

  for (const histogram of all.histograms) {
    output += `# HELP ${histogram.name} ${histogram.description}\n`;
    output += `# TYPE ${histogram.name} histogram\n`;
    const buckets = histogram.getBucketCounts();
    for (const [bucket, count] of Object.entries(buckets)) {
      output += `${histogram.name}_bucket{le="${bucket}"} ${count}\n`;
    }
    output += `${histogram.name}_count ${histogram.getCount()}\n`;
    output += `${histogram.name}_sum ${histogram.values.reduce((s, v) => s + v.value, 0)}\n\n`;
  }

  return output;
}