// ============================================================
// Swarm DAO Core — Artefact Generation
// ============================================================

import type {
  ADR,
  DAOArtefacts,
  DecisionBrief,
  ImplementationPlan,
  PRDLite,
  Proposal,
  ReleasePacket,
  RiskReport,
  TestPlan,
} from "../types/index.js";

// ── Decision Brief ───────────────────────────────────────────

function generateDecisionBrief(proposal: Proposal): DecisionBrief {
  const forVotes = proposal.votes?.filter((v) => v.position === "for") ?? [];
  const safeWeight = (weight: number): number => (Number.isFinite(weight) && weight > 0 ? weight : 0);
  const totalWeight = proposal.votes?.reduce((s, v) => s + safeWeight(v.weight), 0) ?? 0;
  const forWeight = forVotes.reduce((s, v) => s + safeWeight(v.weight), 0);
  const approvalScore = totalWeight > 0 ? Math.round((forWeight / totalWeight) * 100) : 0;

  return {
    proposalId: proposal.id,
    title: proposal.title,
    type: proposal.type,
    objective: proposal.problemStatement || proposal.description,
    summary: proposal.synthesis || "No synthesis available",
    approvalScore,
    quorumPercent: 60,
    decision:
      proposal.status === "approved" || proposal.status === "controlled" || proposal.status === "executed"
        ? "approved"
        : "rejected",
    date: proposal.createdAt,
    keyAgents: proposal.votes?.map((v) => ({ name: v.agentName, position: v.position, weight: v.weight })) ?? [],
  };
}

function formatDecisionBrief(brief: DecisionBrief): string {
  return `# Decision Brief — #${brief.proposalId}\n\n**Title:** ${brief.title}\n**Type:** ${brief.type}\n**Decision:** ${brief.decision === "approved" ? "✅ Approved" : "❌ Rejected"}\n**Approval Score:** ${brief.approvalScore}%\n**Date:** ${brief.date}\n\n## Objective\n${brief.objective}\n\n## Summary\n${brief.summary}\n\n## Key Votes\n${brief.keyAgents.map((a) => `- ${a.name}: ${a.position} (w=${a.weight})`).join("\n")}`;
}

// ── ADR (Architecture Decision Record) ───────────────────────

function generateADR(proposal: Proposal): ADR {
  return {
    proposalId: proposal.id,
    adrId: `ADR-${String(proposal.id).padStart(3, "0")}`,
    title: proposal.title,
    status: proposal.status === "executed" ? "accepted" : "proposed",
    context: proposal.context || proposal.description,
    decision: proposal.synthesis || "Pending deliberation",
    options: [
      {
        name: "Selected approach",
        description: proposal.description,
        selected: true,
        pros: ["Aligned with proposal"],
        cons: ["Requires implementation"],
      },
      {
        name: "Alternative: do nothing",
        description: "Maintain current state",
        selected: false,
        pros: ["Zero effort"],
        cons: ["Problem remains unsolved"],
      },
    ],
    consequences: ["Implementation required", "Testing needed", "Documentation updates"],
    rejectedAlternatives: ["Status quo"],
  };
}

function formatADR(adr: ADR): string {
  return `# ${adr.adrId}: ${adr.title}\n\n**Status:** ${adr.status}\n**Context:** ${adr.context}\n\n## Decision\n${adr.decision}\n\n## Options Considered\n${adr.options.map((o) => `### ${o.name}${o.selected ? " ✅" : ""}\n${o.description}\n**Pros:** ${o.pros.join(", ")}\n**Cons:** ${o.cons.join(", ")}`).join("\n\n")}\n\n## Consequences\n${adr.consequences.map((c) => `- ${c}`).join("\n")}\n\n## Rejected Alternatives\n${adr.rejectedAlternatives.map((a) => `- ${a}`).join("\n")}`;
}

// ── Risk Report ──────────────────────────────────────────────

function generateRiskReport(proposal: Proposal): RiskReport {
  const risks = [];
  if (proposal.type === "security-change") {
    risks.push({
      category: "Security",
      description: "Security-sensitive change requires extra review",
      severity: "high" as const,
      likelihood: "medium" as const,
      mitigation: "Security council review + penetration testing",
    });
  }
  risks.push({
    category: "Implementation",
    description: "Implementation may take longer than estimated",
    severity: "medium" as const,
    likelihood: "high" as const,
    mitigation: "Break into smaller tasks, add buffer time",
  });
  risks.push({
    category: "Adoption",
    description: "Users may not adopt the new feature",
    severity: "low" as const,
    likelihood: "medium" as const,
    mitigation: "User testing and feedback loops",
  });

  return {
    proposalId: proposal.id,
    overallRiskScore: proposal.riskZone === "red" ? 8 : proposal.riskZone === "orange" ? 5 : 2,
    riskLevel: proposal.riskZone === "red" ? "critical" : proposal.riskZone === "orange" ? "medium" : "low",
    risks,
    permissions: proposal.type === "security-change" ? ["authentication", "authorization"] : [],
    dataSurfaces: proposal.type === "security-change" ? ["user credentials", "session tokens"] : ["application state"],
    guardrails: ["Code review required", "Tests must pass", "Security review for red zone"],
  };
}

function formatRiskReport(report: RiskReport): string {
  return `# Risk Report — #${report.proposalId}\n\n**Overall Risk Score:** ${report.overallRiskScore}/10\n**Risk Level:** ${report.riskLevel}\n\n## Risks\n${report.risks.map((r) => `### ${r.category} (${r.severity}, ${r.likelihood} likelihood)\n${r.description}\n**Mitigation:** ${r.mitigation}`).join("\n\n")}\n\n## Permissions\n${report.permissions.map((p) => `- ${p}`).join("\n") || "None identified"}\n\n## Data Surfaces\n${report.dataSurfaces.map((d) => `- ${d}`).join("\n")}\n\n## Guardrails\n${report.guardrails.map((g) => `- ${g}`).join("\n")}`;
}

// ── PRD Lite ─────────────────────────────────────────────────

function generatePRDLite(proposal: Proposal): PRDLite {
  const ac = Array.isArray(proposal.acceptanceCriteria)
    ? proposal.acceptanceCriteria.map((c, i) => {
        const text = typeof c === "string" ? c : `${c.given} / ${c.when} / ${c.then}`;
        return {
          id: `US-${i + 1}`,
          title: text,
          asA: "user",
          iWant: text,
          soThat: "I can be more productive",
          acceptanceCriteria: [text],
        };
      })
    : [];

  return {
    proposalId: proposal.id,
    objective: proposal.problemStatement || proposal.description,
    userStories:
      ac.length > 0
        ? ac
        : [
            {
              id: "US-1",
              title: proposal.title,
              asA: "user",
              iWant: proposal.description,
              soThat: "it solves my problem",
              acceptanceCriteria: ["Feature works as described"],
            },
          ],
    inScope: [proposal.title],
    outOfScope: ["Features not mentioned in proposal"],
    metrics: proposal.successMetrics?.map((m) => ({ name: m, baseline: "TBD", target: m })) ?? [],
    openQuestions: ["What is the timeline?", "Are there dependencies?"],
  };
}

function formatPRDLite(prd: PRDLite): string {
  return `# PRD Lite — #${prd.proposalId}\n\n## Objective\n${prd.objective}\n\n## User Stories\n${prd.userStories.map((us) => `### ${us.id}: ${us.title}\n**As a** ${us.asA}\n**I want** ${us.iWant}\n**So that** ${us.soThat}\n**Acceptance Criteria:**\n${us.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}`).join("\n\n")}\n\n## In Scope\n${prd.inScope.map((s) => `- ${s}`).join("\n")}\n\n## Out of Scope\n${prd.outOfScope.map((s) => `- ${s}`).join("\n")}\n\n## Metrics\n${prd.metrics.map((m) => `- ${m.name}: ${m.baseline} → ${m.target}`).join("\n")}\n\n## Open Questions\n${prd.openQuestions.map((q) => `- ${q}`).join("\n")}`;
}

// ── Implementation Plan ──────────────────────────────────────

function generateImplementationPlan(proposal: Proposal): ImplementationPlan {
  return {
    proposalId: proposal.id,
    phases: [
      { number: 1, name: "Setup & Design", tasks: [{ id: "T1", title: "Design", effort: "s", dependencies: [] }] },
      { number: 2, name: "Implementation", tasks: [{ id: "T2", title: "Build", effort: "m", dependencies: ["T1"] }] },
      { number: 3, name: "Testing", tasks: [{ id: "T3", title: "Test", effort: "s", dependencies: ["T2"] }] },
    ],
    branchStrategy: `feature/dao-${proposal.id}-${proposal.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30)}`,
    estimatedDuration: "1-2 weeks",
    criticalPath: ["T1", "T2", "T3"],
  };
}

function formatImplementationPlan(plan: ImplementationPlan): string {
  return `# Implementation Plan — #${plan.proposalId}\n\n**Branch:** \`${plan.branchStrategy}\`\n**Estimated Duration:** ${plan.estimatedDuration}\n\n## Phases\n${plan.phases.map((p) => `### Phase ${p.number}: ${p.name}\n${p.tasks.map((t) => `- ${t.id}: ${t.title} (${t.effort})${t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : ""}`).join("\n")}`).join("\n\n")}\n\n## Critical Path\n${plan.criticalPath.join(" → ")}`;
}

// ── Test Plan ────────────────────────────────────────────────

function generateTestPlan(proposal: Proposal): TestPlan {
  return {
    proposalId: proposal.id,
    unitTests: [{ target: "Core logic", description: `Test ${proposal.title} functionality` }],
    integrationTests: [{ target: "API surface", description: "Test integration with existing systems" }],
    e2eTests: [
      { scenario: "User journey", steps: `1. Navigate to feature\n2. Use ${proposal.title}\n3. Verify result` },
    ],
    nonRegressionChecks: ["Existing tests still pass", "No performance degradation"],
    testEnvironments: ["local", "staging"],
  };
}

function formatTestPlan(plan: TestPlan): string {
  return `# Test Plan — #${plan.proposalId}\n\n## Unit Tests\n${plan.unitTests.map((t) => `- **${t.target}:** ${t.description}`).join("\n")}\n\n## Integration Tests\n${plan.integrationTests.map((t) => `- **${t.target}:** ${t.description}`).join("\n")}\n\n## E2E Tests\n${plan.e2eTests.map((t) => `### ${t.scenario}\n${t.steps}`).join("\n\n")}\n\n## Non-Regression\n${plan.nonRegressionChecks.map((c) => `- ${c}`).join("\n")}\n\n## Environments\n${plan.testEnvironments.map((e) => `- ${e}`).join("\n")}`;
}

// ── Release Packet ───────────────────────────────────────────

function generateReleasePacket(proposal: Proposal): ReleasePacket {
  return {
    proposalId: proposal.id,
    version: "1.0.0",
    changelog: `- Added: ${proposal.title}\n- See proposal #${proposal.id} for details`,
    releaseNotes: `## What's New\n\n${proposal.title}\n\n${proposal.description}`,
    preReleaseChecklist: [
      { item: "All tests pass", checked: false },
      { item: "Documentation updated", checked: false },
      { item: "Security review complete", checked: false },
    ],
    rollbackPlan: "Revert commit and redeploy previous version",
    storeNotes: "No store submission required",
  };
}

function formatReleasePacket(packet: ReleasePacket): string {
  return `# Release Packet — #${packet.proposalId}\n\n**Version:** ${packet.version}\n\n## Changelog\n${packet.changelog}\n\n## Release Notes\n${packet.releaseNotes}\n\n## Pre-Release Checklist\n${packet.preReleaseChecklist.map((c) => `- [${c.checked ? "x" : " "}] ${c.item}`).join("\n")}\n\n## Rollback Plan\n${packet.rollbackPlan}\n\n## Store Notes\n${packet.storeNotes}`;
}

// ── Generate All ─────────────────────────────────────────────

export function generateAllArtefacts(proposal: Proposal): DAOArtefacts {
  const decisionBrief = generateDecisionBrief(proposal);
  const adr = generateADR(proposal);
  const riskReport = generateRiskReport(proposal);
  const prdLite = generatePRDLite(proposal);
  const implementationPlan = generateImplementationPlan(proposal);
  const testPlan = generateTestPlan(proposal);
  const releasePacket = generateReleasePacket(proposal);

  return {
    proposalId: proposal.id,
    generatedAt: new Date().toISOString(),
    decisionBrief,
    adr,
    riskReport,
    prdLite,
    implementationPlan,
    testPlan,
    releasePacket,
  };
}

export function formatAllArtefacts(artefacts: DAOArtefacts): string {
  return `# 📦 Artefacts — Proposal #${artefacts.proposalId}\n\n_Generated at ${artefacts.generatedAt}_\n\n---\n\n${formatDecisionBrief(artefacts.decisionBrief)}\n\n---\n\n${formatADR(artefacts.adr)}\n\n---\n\n${formatRiskReport(artefacts.riskReport)}\n\n---\n\n${formatPRDLite(artefacts.prdLite)}\n\n---\n\n${formatImplementationPlan(artefacts.implementationPlan)}\n\n---\n\n${formatTestPlan(artefacts.testPlan)}\n\n---\n\n${formatReleasePacket(artefacts.releasePacket)}`;
}

export function formatArtefactsSummary(artefacts: DAOArtefacts): string {
  return `# 📦 Artefacts Summary — Proposal #${artefacts.proposalId}\n\n| Artefact | Status |\n|----------|--------|\n| Decision Brief | ✅ |\n| ADR | ✅ |\n| Risk Report | ✅ |\n| PRD Lite | ✅ |\n| Implementation Plan | ✅ |\n| Test Plan | ✅ |\n| Release Packet | ✅ |\n\n_Generated at ${artefacts.generatedAt}_`;
}

// Export individual formatters
export {
  formatADR,
  formatDecisionBrief,
  formatImplementationPlan,
  formatPRDLite,
  formatReleasePacket,
  formatRiskReport,
  formatTestPlan,
  generateADR,
  generateDecisionBrief,
  generateImplementationPlan,
  generatePRDLite,
  generateReleasePacket,
  generateRiskReport,
  generateTestPlan,
};
