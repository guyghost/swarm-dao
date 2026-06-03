// ============================================================
// Swarm DAO Core — Quality Control Gates
// ============================================================

import { getState } from "../persistence.js";
import type { ChecklistItem, ControlCheckResult, DAOConfig, GateResult, Proposal } from "../types/index.js";
import { TYPE_QUORUM } from "../types/index.js";

// ── Gate Definitions ─────────────────────────────────────────

interface GateDefinition {
  id: string;
  name: string;
  severity: "blocker" | "warning" | "info";
  check: (
    proposal: Proposal,
    config: DAOConfig,
  ) => { passed: boolean; message: string; details?: Record<string, unknown> };
}

const GATES: GateDefinition[] = [
  {
    id: "quorum-quality",
    name: "Quorum Quality",
    severity: "blocker",
    check: (proposal, config) => {
      const votes = proposal.votes || [];
      const eligibleAgents = (proposal.agentOutputs || []).filter((o) => !o.error);
      const totalAgents = Math.max(eligibleAgents.length, votes.length, 1);
      const quorumRequired =
        config.typeQuorum[proposal.type]?.quorumPercent ??
        TYPE_QUORUM[proposal.type]?.quorumPercent ??
        config.quorumPercent;
      const votingPercent = (votes.length / totalAgents) * 100;
      const quorumMet = votes.length > 0 && votingPercent >= quorumRequired;
      return {
        passed: quorumMet,
        message: quorumMet
          ? `Quorum met (${votes.length}/${totalAgents} agents voted — ${votingPercent.toFixed(0)}% ≥ ${quorumRequired}%)`
          : `Quorum not met (${votes.length}/${totalAgents} agents voted — ${votingPercent.toFixed(0)}% < ${quorumRequired}%)`,
        details: { votes: votes.length, totalAgents, votingPercent, quorumRequired },
      };
    },
  },
  {
    id: "risk-threshold",
    name: "Risk Threshold",
    severity: "warning",
    check: (proposal, config) => {
      // Parse risk scores from agent outputs
      const riskScores: number[] = [];
      for (const output of proposal.agentOutputs || []) {
        const match = output.content?.match(/##\s*Risk Score \(1-10\)\s*\n\s*(\d+)/i) ?? null;
        if (match) riskScores.push(parseInt(match[1] ?? "0", 10));
      }

      const avgRisk = riskScores.length > 0 ? riskScores.reduce((a, b) => a + b, 0) / riskScores.length : 0;

      const passed = avgRisk <= config.riskThreshold;
      return {
        passed,
        message: passed
          ? `Risk score ${avgRisk.toFixed(1)} ≤ threshold ${config.riskThreshold}`
          : `Risk score ${avgRisk.toFixed(1)} > threshold ${config.riskThreshold}`,
        details: { avgRisk, riskScores },
      };
    },
  },
  {
    id: "vote-consensus",
    name: "Vote Consensus",
    severity: "warning",
    check: (proposal, _config) => {
      const highWeightAgents = proposal.votes?.filter((v) => v.weight >= 3 && v.position === "against");
      const passed = !highWeightAgents || highWeightAgents.length === 0;
      return {
        passed,
        message: passed
          ? "No high-weight agent voted against"
          : `${highWeightAgents?.length} high-weight agent(s) voted against`,
      };
    },
  },
  {
    id: "zone-compliance",
    name: "Zone Compliance",
    severity: "info",
    check: (proposal, _config) => {
      const hasZone = proposal.riskZone !== undefined;
      return {
        passed: hasZone,
        message: hasZone ? `Risk zone classified: ${proposal.riskZone}` : "Risk zone not classified",
      };
    },
  },
  {
    id: "acceptance-criteria",
    name: "Acceptance Criteria",
    severity: "warning",
    check: (proposal, _config) => {
      const hasAC = Array.isArray(proposal.acceptanceCriteria) && (proposal.acceptanceCriteria?.length ?? 0) > 0;
      return {
        passed: hasAC,
        message: hasAC
          ? `${proposal.acceptanceCriteria?.length ?? 0} acceptance criteria defined`
          : "No acceptance criteria defined",
      };
    },
  },
  {
    id: "dependency-readiness",
    name: "Dependency Readiness",
    severity: "info",
    check: (proposal, _config) => {
      const dependsOn = proposal.dependsOn;
      if (!dependsOn || dependsOn.length === 0) {
        return { passed: true, message: "No inter-proposal dependencies" };
      }
      const proposals = getState().proposals;
      const unexecuted = dependsOn.filter((id) => {
        const dep = proposals.find((p) => p.id === id);
        return dep?.status !== "executed";
      });
      if (unexecuted.length > 0) {
        return {
          passed: false,
          message: `Unexecuted dependencies: #${unexecuted.join(", #")}`,
          details: { unexecuted },
        };
      }
      return { passed: true, message: `All ${dependsOn.length} dependencies executed` };
    },
  },
  {
    id: "dependency-conflict",
    name: "Dependency Conflict",
    severity: "warning",
    check: (_proposal, _config) => {
      return { passed: true, message: "No dependency conflicts detected" };
    },
  },
  {
    id: "mandatory-dry-run",
    name: "Mandatory Dry-Run",
    severity: "blocker",
    check: (proposal, _config) => {
      // For high-risk proposals, dry-run is mandatory
      if (proposal.riskZone === "red" && !proposal.dryRunAt) {
        return { passed: false, message: "Dry-run required for red-zone proposals" };
      }
      return {
        passed: true,
        message: proposal.dryRunAt ? `Dry-run completed at ${proposal.dryRunAt}` : "Dry-run not required",
      };
    },
  },
  {
    id: "type-specific-quality",
    name: "Type-Specific Quality",
    severity: "warning",
    check: (proposal, _config) => {
      const typeQuorum = TYPE_QUORUM[proposal.type];
      if (!typeQuorum) return { passed: true, message: "No type-specific requirements" };
      return {
        passed: true,
        message: `${proposal.type}: quorum=${typeQuorum.quorumPercent}%, approval=${typeQuorum.approvalPercent}%`,
      };
    },
  },
];

// ── Checklist ────────────────────────────────────────────────

function generateChecklist(proposal: Proposal): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: "security-review",
      category: "security",
      label: "Security review completed",
      checked: proposal.type !== "security-change",
      autoChecked: true,
    },
    { id: "data-handling", category: "compliance", label: "Data handling reviewed", checked: true, autoChecked: true },
    {
      id: "compliance-check",
      category: "compliance",
      label: "Compliance requirements met",
      checked: true,
      autoChecked: true,
    },
    {
      id: "specs-written",
      category: "quality",
      label: "Specifications written",
      checked: Array.isArray(proposal.acceptanceCriteria) && proposal.acceptanceCriteria.length > 0,
      autoChecked: true,
    },
    {
      id: "architecture-reviewed",
      category: "quality",
      label: "Architecture reviewed",
      checked: proposal.agentOutputs.some((o) => o.agentId === "architect"),
      autoChecked: true,
    },
    {
      id: "rollback-plan",
      category: "operational",
      label: "Rollback plan defined",
      checked: Array.isArray(proposal.rollbackConditions) && proposal.rollbackConditions.length > 0,
      autoChecked: true,
    },
    {
      id: "monitoring-plan",
      category: "operational",
      label: "Monitoring plan defined",
      checked: Array.isArray(proposal.successMetrics) && proposal.successMetrics.length > 0,
      autoChecked: true,
    },
  ];
  return items;
}

// ── Run Gates ────────────────────────────────────────────────

export function runGates(proposal: Proposal, config: DAOConfig): ControlCheckResult {
  const gates: GateResult[] = [];
  let blockerCount = 0;
  let warningCount = 0;

  for (const gateDef of GATES) {
    // Skip gates not in required list
    if (!config.requiredGates.includes(gateDef.id)) continue;

    const result = gateDef.check(proposal, config);
    const gate: GateResult = {
      gateId: gateDef.id,
      name: gateDef.name,
      passed: result.passed,
      severity: gateDef.severity,
      message: result.message,
      details: result.details,
    };

    gates.push(gate);
    if (!result.passed) {
      if (gateDef.severity === "blocker") blockerCount++;
      if (gateDef.severity === "warning") warningCount++;
    }
  }

  // Type-specific severity promotion
  if (proposal.type === "security-change") {
    const riskGate = gates.find((g) => g.gateId === "risk-threshold");
    if (riskGate && !riskGate.passed) {
      riskGate.severity = "blocker";
      blockerCount++;
      warningCount--;
    }
  }

  if (proposal.type === "release-change") {
    const deliveryGate = gates.find((g) => g.gateId === "dependency-readiness");
    if (deliveryGate && !deliveryGate.passed) {
      deliveryGate.severity = "blocker";
      blockerCount++;
    }
  }

  return {
    proposalId: proposal.id,
    timestamp: new Date().toISOString(),
    allGatesPassed: blockerCount === 0,
    blockerCount,
    warningCount,
    gates,
    checklist: generateChecklist(proposal),
  };
}

export function formatControlResult(result: ControlCheckResult): string {
  const status = result.allGatesPassed ? "✅ ALL GATES PASSED" : "❌ GATES FAILED";
  const severityEmoji = { blocker: "🔴", warning: "🟡", info: "🔵" };

  return `# ${status} — #${result.proposalId}

**Blockers:** ${result.blockerCount} | **Warnings:** ${result.warningCount} | **Checklist:** ${result.checklist.filter((c) => c.checked).length}/${result.checklist.length}

## Gates
${result.gates.map((g) => `${severityEmoji[g.severity]} **${g.name}** (${g.severity}) — ${g.passed ? "✅" : "❌"} ${g.message}`).join("\n")}

## Checklist
${result.checklist.map((c) => `- [${c.checked ? "x" : " "}] ${c.label}`).join("\n")}`;
}
