// ============================================================
// Swarm DAO Core — Alerting System
// ============================================================

import { getCounter, getGauge, getHistogram } from "./metrics.js";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertCondition = "gt" | "lt" | "eq" | "gte" | "lte";

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  metric: string;
  condition: AlertCondition;
  threshold: number;
  severity: AlertSeverity;
  duration?: number; // seconds the condition must persist
  enabled: boolean;
}

export interface Alert {
  id: string;
  ruleId: string;
  name: string;
  description: string;
  severity: AlertSeverity;
  metric: string;
  value: number;
  threshold: number;
  condition: AlertCondition;
  triggeredAt: string;
  resolvedAt?: string;
  status: "firing" | "resolved";
}

const rules: AlertRule[] = [];
const alerts: Alert[] = [];
let alertIdCounter = 1;

export function createAlertRule(rule: Omit<AlertRule, "id">): AlertRule {
  const newRule: AlertRule = { ...rule, id: `rule-${alertIdCounter++}` };
  rules.push(newRule);
  return newRule;
}

export function removeAlertRule(ruleId: string): boolean {
  const index = rules.findIndex((r) => r.id === ruleId);
  if (index === -1) return false;
  rules.splice(index, 1);
  return true;
}

export function getAlertRules(): AlertRule[] {
  return [...rules];
}

export function getActiveAlerts(): Alert[] {
  return alerts.filter((a) => a.status === "firing");
}

export function getAllAlerts(): Alert[] {
  return [...alerts];
}

export function resolveAlert(alertId: string): boolean {
  const alert = alerts.find((a) => a.id === alertId);
  if (!alert || alert.status === "resolved") return false;
  alert.status = "resolved";
  alert.resolvedAt = new Date().toISOString();
  return true;
}

function evaluateCondition(value: number, condition: AlertCondition, threshold: number): boolean {
  switch (condition) {
    case "gt":
      return value > threshold;
    case "lt":
      return value < threshold;
    case "eq":
      return value === threshold;
    case "gte":
      return value >= threshold;
    case "lte":
      return value <= threshold;
    default:
      return false;
  }
}

function getMetricValue(metricName: string): number {
  const counter = getCounter(metricName);
  if (counter) return counter.getCount();

  const gauge = getGauge(metricName);
  if (gauge) return gauge.getValue();

  const histogram = getHistogram(metricName);
  if (histogram) return histogram.getCount();

  return 0;
}

export function evaluateRules(): Alert[] {
  const newAlerts: Alert[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const value = getMetricValue(rule.metric);
    const triggered = evaluateCondition(value, rule.condition, rule.threshold);

    const existing = alerts.find((a) => a.ruleId === rule.id && a.status === "firing");

    if (triggered && !existing) {
      const alert: Alert = {
        id: `alert-${alertIdCounter++}`,
        ruleId: rule.id,
        name: rule.name,
        description: rule.description,
        severity: rule.severity,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        condition: rule.condition,
        triggeredAt: new Date().toISOString(),
        status: "firing",
      };
      alerts.push(alert);
      newAlerts.push(alert);
    } else if (!triggered && existing) {
      resolveAlert(existing.id);
    }
  }

  return newAlerts;
}

export function formatAlert(alert: Alert): string {
  const emoji = { info: "ℹ️", warning: "⚠️", critical: "🚨" }[alert.severity];
  const status = alert.status === "firing" ? "🔥 FIRING" : "✅ RESOLVED";

  return (
    `${emoji} **${alert.name}** — ${status}\n` +
    `Metric: \`${alert.metric}\` = ${alert.value} (threshold: ${alert.condition} ${alert.threshold})\n` +
    `Triggered: ${alert.triggeredAt}${alert.resolvedAt ? ` | Resolved: ${alert.resolvedAt}` : ""}`
  );
}

export function formatAlerts(): string {
  const active = getActiveAlerts();
  if (active.length === 0) return "# 🟢 No Active Alerts\n\nAll systems nominal.";

  let output = "# 🚨 Active Alerts\n\n";
  for (const alert of active) {
    output += `${formatAlert(alert)}\n\n`;
  }
  return output;
}

// ── Default Rules ────────────────────────────────────────────

export const DEFAULT_ALERT_RULES: Omit<AlertRule, "id">[] = [
  {
    name: "Low Approval Rate",
    description: "Approval rate has dropped below 40%",
    metric: "dao_approval_rate_percent",
    condition: "lt",
    threshold: 40,
    severity: "warning",
    enabled: true,
  },
  {
    name: "High Deliberation Time",
    description: "P95 deliberation time exceeds 30 seconds",
    metric: "dao_deliberation_duration_ms",
    condition: "gt",
    threshold: 30000,
    severity: "warning",
    enabled: true,
  },
  {
    name: "No Active Agents",
    description: "Number of active agents has dropped to 0",
    metric: "dao_agent_count",
    condition: "lte",
    threshold: 0,
    severity: "critical",
    enabled: true,
  },
  {
    name: "Too Many Open Proposals",
    description: "More than 20 proposals are open simultaneously",
    metric: "dao_active_proposals",
    condition: "gt",
    threshold: 20,
    severity: "info",
    enabled: true,
  },
];

export function resetAlerts(): void {
  rules.length = 0;
  alerts.length = 0;
  alertIdCounter = 1;
}

export function initializeDefaultAlertRules(): void {
  for (const rule of DEFAULT_ALERT_RULES) {
    createAlertRule(rule);
  }
}
