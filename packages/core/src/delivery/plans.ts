// ============================================================
// Swarm DAO Core — Delivery Plans
// ============================================================

import type { DeliveryPlan, DeliveryPhase, DeliveryTask, Proposal } from "../types/index.js";
import { getState, storeDeliveryPlan, getDeliveryPlan as persistGetDeliveryPlan } from "../persistence.js";

export { persistGetDeliveryPlan as getPlan, storeDeliveryPlan as storePlan };

export function generateDeliveryPlan(proposal: Proposal): DeliveryPlan {
  const phases: DeliveryPhase[] = [
    {
      number: 1,
      name: "Setup & Design",
      tasks: [
        { id: "T1", title: "Review proposal and acceptance criteria", description: "Understand requirements and clarify ambiguities", effort: "xs", phase: 1, dependencies: [], status: "pending" },
        { id: "T2", title: "Design solution", description: "Create technical design document", effort: "s", phase: 1, dependencies: ["T1"], status: "pending" },
        { id: "T3", title: "Set up feature branch", description: "Create branch for implementation", effort: "xs", phase: 1, dependencies: ["T2"], status: "pending" },
      ],
      duration: "1-2 days",
    },
    {
      number: 2,
      name: "Implementation",
      tasks: [
        { id: "T4", title: "Core implementation", description: "Implement the main functionality", effort: "m", phase: 2, dependencies: ["T3"], status: "pending" },
        { id: "T5", title: "Add tests", description: "Unit and integration tests", effort: "m", phase: 2, dependencies: ["T4"], status: "pending" },
        { id: "T6", title: "Documentation", description: "Update docs and README", effort: "s", phase: 2, dependencies: ["T4"], status: "pending" },
      ],
      duration: "3-5 days",
    },
    {
      number: 3,
      name: "Review & Release",
      tasks: [
        { id: "T7", title: "Code review", description: "Self-review and peer review", effort: "s", phase: 3, dependencies: ["T5", "T6"], status: "pending" },
        { id: "T8", title: "Quality gates", description: "Run control checks and verify acceptance criteria", effort: "s", phase: 3, dependencies: ["T7"], status: "pending" },
        { id: "T9", title: "Merge and deploy", description: "Merge to main and deploy", effort: "xs", phase: 3, dependencies: ["T8"], status: "pending" },
      ],
      duration: "1-2 days",
    },
  ];

  return {
    proposalId: proposal.id,
    createdAt: new Date().toISOString(),
    phases,
    branchStrategy: `feature/dao-${proposal.id}-${proposal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`,
    rollbackPlan: "Revert the merge commit and redeploy previous version",
    estimatedDuration: "5-9 days",
  };
}

export function parseDeliveryPlan(markdown: string): Partial<DeliveryPlan> {
  // Simple parser for markdown plan format
  const plan: Partial<DeliveryPlan> = { phases: [] };

  const phaseMatches = [...markdown.matchAll(/##\s*Phase\s*(\d+):\s*(.+?)\n([\s\S]*?)(?=##\s*Phase|\n##\s*Rollback|$)/gi)];
  for (const match of phaseMatches) {
    const phaseNum = parseInt(match[1]!, 10);
    const phaseName = match[2]!.trim();
    const phaseContent = match[3] ?? "";

    const tasks: DeliveryTask[] = [];
    const taskMatches = [...phaseContent.matchAll(/-\s*\[(.)\]\s*\*\*(.+?)\*\*\s*-\s*(.+?)(?:\n|$)/gi)];
    for (const tm of taskMatches) {
      tasks.push({
        id: `T${tasks.length + 1}`,
        title: tm[2]!.trim(),
        description: tm[3]!.trim(),
        effort: "m",
        phase: phaseNum,
        dependencies: [],
        status: tm[1] === "x" ? "done" : "pending",
      });
    }

    plan.phases!.push({
      number: phaseNum,
      name: phaseName,
      tasks,
      duration: "TBD",
    });
  }

  return plan;
}

export function formatPlan(plan: DeliveryPlan): string {
  return `# 📋 Delivery Plan — Proposal #${plan.proposalId}

**Created:** ${plan.createdAt}
**Estimated Duration:** ${plan.estimatedDuration}
**Branch Strategy:** \`${plan.branchStrategy}\`

## Phases
${plan.phases.map((phase) => `### Phase ${phase.number}: ${phase.name} (${phase.duration})
${phase.tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] **${t.title}** — ${t.description} (${t.effort})`).join("\n")}
`).join("\n")}

## Rollback Plan
${plan.rollbackPlan}`;
}