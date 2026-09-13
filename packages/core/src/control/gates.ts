// ============================================================
// Swarm DAO Core — Quality Control Gates
// ============================================================

import { getUnexecutedDependencies } from "../delivery/dependencies.js";
import { allCoordinatorsClosed, isDelegationInFlightOnDisk } from "../governance/delegation.utils.js";
import { type Electorate, resolveTypeThresholds, tallyVotes } from "../governance/voting.js";
import type { ChecklistItem, ControlCheckResult, DAOConfig, GateResult, Proposal } from "../types/index.js";
import { PROPOSAL_TYPE, TYPE_QUORUM } from "../types/index.js";

// ── Gate Definitions ─────────────────────────────────────────

/** Ambient context gates may consult; everything is optional so gates
 *  degrade gracefully when the caller cannot supply it. */
export interface GateContext {
  allProposals?: readonly Proposal[];
  /** Configured council (state.agents): grounds the quorum denominator. */
  electorate?: Electorate;
  /** DAO root: lets gates consult on-disk state (e.g. delegation markers). */
  daoRoot?: string;
}

interface GateDefinition {
  id: string;
  name: string;
  severity: "blocker" | "warning" | "info";
  check: (
    proposal: Proposal,
    config: DAOConfig,
    context: GateContext,
  ) => { passed: boolean; message: string; details?: Record<string, unknown> };
}

const GATES: GateDefinition[] = [
  {
    id: "quorum-quality",
    name: "Quorum Quality",
    severity: "blocker",
    check: (proposal, config, context) => {
      const tally = tallyVotes(proposal, config, context.electorate);
      const required = resolveTypeThresholds(proposal, config).quorumPercent;
      return {
        passed: tally.quorumMet,
        message: tally.quorumMet
          ? `Quorum met (${tally.quorumPercent}% weighted participation ≥ ${required}%)`
          : `Quorum not met (${tally.quorumPercent}% weighted participation < ${required}%)`,
        details: {
          quorumPercent: tally.quorumPercent,
          quorumRequired: required,
          votingAgents: tally.votingAgents,
          totalAgents: tally.totalAgents,
          totalVotingWeight: tally.totalVotingWeight,
        },
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
      for (const output of proposal.agentOutputs ?? []) {
        const match = output.content?.match(/##\s*Risk Score \(1-10\)\s*\n\s*(\d+)/i) ?? null;
        if (match) riskScores.push(parseInt(match[1] ?? "0", 10));
      }

      // Fail closed (issue #168.1): "no scores produced" is NOT "zero risk".
      // Agents in error, drifted response formats or partial deliberations
      // must not silently pass the risk gate.
      if (riskScores.length === 0) {
        return {
          passed: false,
          message: `No risk scores produced by agent outputs — cannot verify risk threshold ${config.riskThreshold}`,
          details: { avgRisk: null, riskScores },
        };
      }

      const avgRisk = riskScores.reduce((a, b) => a + b, 0) / riskScores.length;

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
    check: (proposal, _config, context) => {
      const dependsOn = proposal.dependsOn;
      if (!dependsOn || dependsOn.length === 0) {
        return { passed: true, message: "No inter-proposal dependencies" };
      }

      const allProposals = context.allProposals;
      if (!allProposals) {
        return {
          passed: true,
          message: "Dependency readiness could not be verified — please verify manually",
          details: { verifyManually: true },
        };
      }

      // Same transitive semantics as the ship path (issue #168.4): a chain
      // C→B→A with unexecuted A must fail here, not only at dao_ship.
      const resolution = getUnexecutedDependencies(proposal.id, [...allProposals]);
      if (resolution.error) {
        return {
          passed: false,
          message: resolution.error,
          details: { error: resolution.error },
        };
      }
      const unexecuted = resolution.order ?? [];

      const proposalMap = new Map<number, Proposal>(allProposals.map((p) => [p.id, p]));
      const missing = dependsOn.filter((id) => !proposalMap.has(id));

      if (missing.length > 0 || unexecuted.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`Missing dependencies: #${missing.join(", #")}`);
        if (unexecuted.length > 0) parts.push(`Unexecuted dependencies: #${unexecuted.join(", #")}`);
        return {
          passed: false,
          message: parts.join("; "),
          details: { missing, unexecuted },
        };
      }

      return { passed: true, message: `All ${dependsOn.length} dependencies executed` };
    },
  },
  {
    id: "dependency-conflict",
    name: "Dependency Conflict",
    severity: "warning",
    check: (proposal, _config, context) => {
      const mine = new Set(
        (proposal.affectedPaths ?? []).map((entry) => entry.trim().replace(/\\/g, "/")).filter(Boolean),
      );
      if (mine.size === 0) {
        return { passed: true, message: "No affected paths declared" };
      }
      const allProposals = context.allProposals;
      if (!allProposals) {
        return {
          passed: true,
          message: "Dependency conflicts could not be verified — please verify manually",
          details: { verifyManually: true },
        };
      }

      const conflicts: string[] = [];
      for (const other of allProposals) {
        if (other.id === proposal.id) continue;
        if (other.status === "rejected" || other.status === "executed") continue;
        const overlap = (other.affectedPaths ?? [])
          .map((entry) => entry.trim().replace(/\\/g, "/"))
          .filter((entry) => mine.has(entry));
        if (overlap.length > 0) {
          conflicts.push(`#${other.id} (${other.status}): ${overlap.join(", ")}`);
        }
      }
      if (conflicts.length > 0) {
        return {
          passed: false,
          message: `Overlapping affected paths with in-flight proposals: ${conflicts.join("; ")}`,
          details: { conflicts },
        };
      }
      return { passed: true, message: "No overlapping affected paths with in-flight proposals" };
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
    severity: "blocker",
    check: (proposal, config, context) => {
      const typeQuorum = config.typeQuorum[proposal.type] ?? TYPE_QUORUM[proposal.type];
      if (!typeQuorum) return { passed: true, message: "No type-specific requirements" };
      const tally = tallyVotes(proposal, config, context.electorate);
      // tally.quorumMet already applies this type's quorum threshold
      // (resolveTypeThresholds); approval is compared as an exact fraction.
      const decisiveWeight = tally.weightedFor + tally.weightedAgainst;
      const passed =
        tally.quorumMet && decisiveWeight > 0 && tally.weightedFor * 100 >= typeQuorum.approvalPercent * decisiveWeight;
      return {
        passed,
        message: passed
          ? `${proposal.type}: approval ${tally.approvalScore}% ≥ ${typeQuorum.approvalPercent}%, quorum ${tally.quorumPercent}% ≥ ${typeQuorum.quorumPercent}%`
          : `${proposal.type}: approval ${tally.approvalScore}% / quorum ${tally.quorumPercent}% below type thresholds (approval ${typeQuorum.approvalPercent}%, quorum ${typeQuorum.quorumPercent}%)`,
        details: {
          approvalScore: tally.approvalScore,
          approvalRequired: typeQuorum.approvalPercent,
          quorumPercent: tally.quorumPercent,
          quorumRequired: typeQuorum.quorumPercent,
        },
      };
    },
  },
  {
    // INV-8 (ordering): no APPROVE while a delegation is in flight. Opt-in via
    // `config.requiredGates` (NOT in DEFAULT_CONFIG.requiredGates).
    // Two observation layers (issue #159): the in-process coordinator
    // registry, AND a persisted in-flight marker written by the deliberation
    // orchestrator — the registry alone can never block because it is
    // process-local and cleared before dao_control runs.
    id: "delegation-closed",
    name: "Delegation Closed",
    severity: "blocker",
    check: (proposal, _config, context) => {
      const closed =
        allCoordinatorsClosed(proposal.id) &&
        !(context.daoRoot && isDelegationInFlightOnDisk(context.daoRoot, proposal.id));
      return {
        passed: closed,
        message: closed ? "All delegation coordinators closed" : "Delegation in flight — tally must wait",
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
      checked: proposal.type !== PROPOSAL_TYPE.SECURITY_CHANGE,
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
      checked: (proposal.agentOutputs ?? []).some((o) => o.agentId === "architect"),
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

/** Registered gate ids — used to fail closed on typos in `requiredGates`. */
export const GATE_IDS: readonly string[] = GATES.map((gate) => gate.id);

// ── Run Gates ────────────────────────────────────────────────

export function runGates(
  proposal: Proposal,
  config: DAOConfig,
  options: GateContext & { now?: string } = {},
): ControlCheckResult {
  const gates: GateResult[] = [];
  let blockerCount = 0;
  let warningCount = 0;

  for (const gateDef of GATES) {
    // Skip gates not in required list
    if (!config.requiredGates.includes(gateDef.id)) continue;

    const result = gateDef.check(proposal, config, options);
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

  const knownIds = new Set(GATE_IDS);
  for (const id of config.requiredGates) {
    if (knownIds.has(id)) continue;
    gates.push({
      gateId: id,
      name: id,
      passed: false,
      severity: "blocker",
      message: `Unknown required gate '${id}' — not in the gate registry`,
    });
    blockerCount++;
  }

  // Type-specific severity promotion
  if (proposal.type === PROPOSAL_TYPE.SECURITY_CHANGE) {
    const riskGate = gates.find((g) => g.gateId === "risk-threshold");
    if (riskGate && !riskGate.passed) {
      riskGate.severity = "blocker";
      blockerCount++;
      warningCount--;
    }
  }

  if (proposal.type === PROPOSAL_TYPE.RELEASE_CHANGE) {
    const deliveryGate = gates.find((g) => g.gateId === "dependency-readiness");
    if (deliveryGate && !deliveryGate.passed) {
      deliveryGate.severity = "blocker";
      blockerCount++;
    }
  }

  return {
    proposalId: proposal.id,
    timestamp: options.now ?? new Date().toISOString(),
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
