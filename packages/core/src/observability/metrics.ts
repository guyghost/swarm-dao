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

/**
 * Maximum number of distinct label-sets retained per metric. Memory is bounded
 * by this cap (× bucket count for histograms). When exceeded, new label-sets
 * fold into the unlabeled bucket so the exact grand total is preserved; only
 * the per-label breakdown beyond the cap becomes approximate. Equivalent to a
 * Prometheus cardinality limit.
 */
const MAX_LABEL_SETS = 1024;
/** Bounded recent-observation sample retained on the public `values` field. */
const RECENT_SAMPLE_CAP = 128;
/** Bounded reservoir used for percentile estimation on histograms. */
const RESERVOIR_CAP = 256;

function labelSignature(labels?: Record<string, string>): string {
  if (!labels) return "";
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  keys.sort();
  let sig = "";
  for (const k of keys) sig += `${k}=${labels[k]}\u0001`;
  return sig;
}

function pushRecentSample(arr: MetricValue[], mv: MetricValue): void {
  if (arr.length >= RECENT_SAMPLE_CAP) arr.shift();
  arr.push(mv);
}

function timestamp(): string {
  return new Date().toISOString();
}

export interface Counter {
  name: string;
  description: string;
  /** Bounded recent-observation sample for inspection (not authoritative). */
  values: MetricValue[];
  increment(labels?: Record<string, string>): void;
  getCount(labels?: Record<string, string>): number;
  reset(): void;
}

export interface Gauge {
  name: string;
  description: string;
  /** Bounded recent-observation sample for inspection (not authoritative). */
  values: MetricValue[];
  set(value: number, labels?: Record<string, string>): void;
  getValue(labels?: Record<string, string>): number;
  reset(): void;
}

export interface Histogram {
  name: string;
  description: string;
  buckets: number[];
  /** Bounded recent-observation sample for inspection (not authoritative). */
  values: MetricValue[];
  observe(value: number, labels?: Record<string, string>): void;
  getPercentile(p: number, labels?: Record<string, string>): number;
  getCount(labels?: Record<string, string>): number;
  getSum(labels?: Record<string, string>): number;
  getBucketCounts(labels?: Record<string, string>): Record<string, number>;
  reset(): void;
}

interface CounterAggregate {
  labels?: Record<string, string>;
  count: number;
}

class CounterImpl implements Counter {
  values: MetricValue[] = [];
  private readonly aggregates = new Map<string, CounterAggregate>();

  constructor(
    public name: string,
    public description: string,
  ) {}

  increment(labels?: Record<string, string>): void {
    this.getOrCreate(labels).count++;
    pushRecentSample(this.values, { name: this.name, value: 1, timestamp: timestamp(), labels });
  }

  getCount(labels?: Record<string, string>): number {
    let total = 0;
    for (const agg of this.aggregates.values()) {
      if (matchesLabels(agg.labels, labels)) total += agg.count;
    }
    return total;
  }

  reset(): void {
    this.values = [];
    this.aggregates.clear();
  }

  private getOrCreate(labels?: Record<string, string>): CounterAggregate {
    const sig = labelSignature(labels);
    const existing = this.aggregates.get(sig);
    if (existing) return existing;
    if (this.aggregates.size >= MAX_LABEL_SETS) {
      // Fold overflow into the unlabeled bucket so the grand total stays exact.
      const overflow = this.aggregates.get("");
      if (overflow) return overflow;
      const created: CounterAggregate = { count: 0 };
      this.aggregates.set("", created);
      return created;
    }
    const created: CounterAggregate = { labels, count: 0 };
    this.aggregates.set(sig, created);
    return created;
  }
}

interface GaugeAggregate {
  labels?: Record<string, string>;
  value: number;
  seq: number;
}

class GaugeImpl implements Gauge {
  values: MetricValue[] = [];
  private readonly aggregates = new Map<string, GaugeAggregate>();
  private seq = 0;

  constructor(
    public name: string,
    public description: string,
  ) {}

  set(value: number, labels?: Record<string, string>): void {
    const agg = this.getOrCreate(labels);
    agg.value = value;
    agg.seq = ++this.seq;
    pushRecentSample(this.values, { name: this.name, value, timestamp: timestamp(), labels });
  }

  getValue(labels?: Record<string, string>): number {
    let best: GaugeAggregate | undefined;
    for (const agg of this.aggregates.values()) {
      if (!matchesLabels(agg.labels, labels)) continue;
      if (!best || agg.seq > best.seq) best = agg;
    }
    return best?.value ?? 0;
  }

  reset(): void {
    this.values = [];
    this.aggregates.clear();
    this.seq = 0;
  }

  private getOrCreate(labels?: Record<string, string>): GaugeAggregate {
    const sig = labelSignature(labels);
    const existing = this.aggregates.get(sig);
    if (existing) return existing;
    if (this.aggregates.size >= MAX_LABEL_SETS) {
      const overflow = this.aggregates.get("");
      if (overflow) return overflow;
      const created: GaugeAggregate = { value: 0, seq: 0 };
      this.aggregates.set("", created);
      return created;
    }
    const created: GaugeAggregate = { labels, value: 0, seq: 0 };
    this.aggregates.set(sig, created);
    return created;
  }
}

interface HistogramAggregate {
  labels?: Record<string, string>;
  count: number;
  sum: number;
  /** Cumulative counts per bucket boundary; last entry is `+Inf`. */
  bucketCounts: number[];
  /** Bounded reservoir of recent observed values for percentile estimation. */
  samples: number[];
}

class HistogramImpl implements Histogram {
  values: MetricValue[] = [];
  private readonly aggregates = new Map<string, HistogramAggregate>();

  constructor(
    public name: string,
    public description: string,
    public buckets: number[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  ) {}

  observe(value: number, labels?: Record<string, string>): void {
    const agg = this.getOrCreate(labels);
    agg.count++;
    agg.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] ?? Number.POSITIVE_INFINITY)) {
        agg.bucketCounts[i] = (agg.bucketCounts[i] ?? 0) + 1;
      }
    }
    const infIdx = this.buckets.length;
    agg.bucketCounts[infIdx] = (agg.bucketCounts[infIdx] ?? 0) + 1; // +Inf
    if (agg.samples.length >= RESERVOIR_CAP) agg.samples.shift();
    agg.samples.push(value);
    pushRecentSample(this.values, { name: this.name, value, timestamp: timestamp(), labels });
  }

  getCount(labels?: Record<string, string>): number {
    let total = 0;
    for (const agg of this.aggregates.values()) {
      if (matchesLabels(agg.labels, labels)) total += agg.count;
    }
    return total;
  }

  getSum(labels?: Record<string, string>): number {
    let total = 0;
    for (const agg of this.aggregates.values()) {
      if (matchesLabels(agg.labels, labels)) total += agg.sum;
    }
    return total;
  }

  getPercentile(p: number, labels?: Record<string, string>): number {
    const samples: number[] = [];
    for (const agg of this.aggregates.values()) {
      if (matchesLabels(agg.labels, labels)) {
        for (const s of agg.samples) samples.push(s);
      }
    }
    if (samples.length === 0) return 0;
    samples.sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil((p / 100) * samples.length) - 1);
    return samples[index] ?? 0;
  }

  getBucketCounts(labels?: Record<string, string>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let i = 0; i < this.buckets.length; i++) counts[`le_${this.buckets[i]}`] = 0;
    counts["+Inf"] = 0;
    for (const agg of this.aggregates.values()) {
      if (!matchesLabels(agg.labels, labels)) continue;
      for (let i = 0; i < this.buckets.length; i++) {
        const key = `le_${this.buckets[i]}`;
        counts[key] = (counts[key] ?? 0) + (agg.bucketCounts[i] ?? 0);
      }
      counts["+Inf"] = (counts["+Inf"] ?? 0) + (agg.bucketCounts[this.buckets.length] ?? 0);
    }
    return counts;
  }

  reset(): void {
    this.values = [];
    this.aggregates.clear();
  }

  private getOrCreate(labels?: Record<string, string>): HistogramAggregate {
    const sig = labelSignature(labels);
    const existing = this.aggregates.get(sig);
    if (existing) return existing;
    const bucketCounts = new Array<number>(this.buckets.length + 1).fill(0);
    if (this.aggregates.size >= MAX_LABEL_SETS) {
      const overflow = this.aggregates.get("");
      if (overflow) return overflow;
      const created: HistogramAggregate = { count: 0, sum: 0, bucketCounts, samples: [] };
      this.aggregates.set("", created);
      return created;
    }
    const created: HistogramAggregate = { labels, count: 0, sum: 0, bucketCounts, samples: [] };
    this.aggregates.set(sig, created);
    return created;
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
  for (const counter of counters.values()) counter.reset();
  for (const gauge of gauges.values()) gauge.reset();
  for (const histogram of histograms.values()) histogram.reset();
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

export function recordProposalApproved(_id: number, type: string): void {
  DAO_METRICS.proposalsApproved.increment({ type });
  updateApprovalRate();
}

export function recordProposalRejected(_id: number, type: string): void {
  DAO_METRICS.proposalsRejected.increment({ type });
  updateApprovalRate();
}

export function recordProposalExecuted(_id: number, type: string): void {
  DAO_METRICS.proposalsExecuted.increment({ type });
  DAO_METRICS.activeProposals.set(Math.max(0, DAO_METRICS.activeProposals.getValue() - 1));
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
    output += `${histogram.name}_sum ${histogram.getSum()}\n\n`;
  }

  return output;
}
