// ============================================================
// Swarm DAO Core — Delivery Plans
// ============================================================

import { getDeliveryPlan as persistGetDeliveryPlan, storeDeliveryPlan } from "../persistence.js";
import type { DeliveryPhase, DeliveryPlan, DeliveryTask, Proposal } from "../types/index.js";

export { persistGetDeliveryPlan as getPlan, storeDeliveryPlan as storePlan };

/**
 * Generates the default set of delivery phases for a new plan.
 */
function createDefaultPhases(): DeliveryPhase[] {
  return [
    {
      number: 1,
      name: "Setup & Design",
      tasks: [
        {
          id: "T1",
          title: "Review proposal and acceptance criteria",
          description: "Understand requirements and clarify ambiguities",
          effort: "xs",
          phase: 1,
          dependencies: [],
          status: "pending",
        },
        {
          id: "T2",
          title: "Design solution",
          description: "Create technical design document",
          effort: "s",
          phase: 1,
          dependencies: ["T1"],
          status: "pending",
        },
        {
          id: "T3",
          title: "Set up feature branch",
          description: "Create branch for implementation",
          effort: "xs",
          phase: 1,
          dependencies: ["T2"],
          status: "pending",
        },
      ],
      duration: "1-2 days",
    },
    {
      number: 2,
      name: "Implementation",
      tasks: [
        {
          id: "T4",
          title: "Core implementation",
          description: "Implement the main functionality",
          effort: "m",
          phase: 2,
          dependencies: ["T3"],
          status: "pending",
        },
        {
          id: "T5",
          title: "Add tests",
          description: "Unit and integration tests",
          effort: "m",
          phase: 2,
          dependencies: ["T4"],
          status: "pending",
        },
        {
          id: "T6",
          title: "Documentation",
          description: "Update docs and README",
          effort: "s",
          phase: 2,
          dependencies: ["T4"],
          status: "pending",
        },
      ],
      duration: "3-5 days",
    },
    {
      number: 3,
      name: "Review & Release",
      tasks: [
        {
          id: "T7",
          title: "Code review",
          description: "Self-review and peer review",
          effort: "s",
          phase: 3,
          dependencies: ["T5", "T6"],
          status: "pending",
        },
        {
          id: "T8",
          title: "Quality gates",
          description: "Run control checks and verify acceptance criteria",
          effort: "s",
          phase: 3,
          dependencies: ["T7"],
          status: "pending",
        },
        {
          id: "T9",
          title: "Merge and deploy",
          description: "Merge to main and deploy",
          effort: "xs",
          phase: 3,
          dependencies: ["T8"],
          status: "pending",
        },
      ],
      duration: "1-2 days",
    },
  ];
}

/**
 * Generates a standardized branch name for a proposal.
 */
function generateBranchName(proposal: Proposal): string {
  const slug = proposal.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30);
  return `feature/dao-${proposal.id}-${slug}`;
}

export function generateDeliveryPlan(proposal: Proposal, options: { now?: string } = {}): DeliveryPlan {
  return {
    proposalId: proposal.id,
    createdAt: options.now ?? new Date().toISOString(),
    phases: createDefaultPhases(),
    branchStrategy: generateBranchName(proposal),
    rollbackPlan: "Revert the merge commit and redeploy previous version",
    estimatedDuration: "5-9 days",
  };
}

export function parseDeliveryPlan(markdown: string): Partial<DeliveryPlan> {
  // Line-oriented parser for the markdown plan format (ReDoS-safe): phases
  // are delimited by scanning heading lines, never by [\s\S]*? lookahead
  // alternations. Mirrors the original delimiters: a phase body runs until
  // the next "## Phase" heading, a "## Rollback" heading, or EOF.
  const plan: Partial<DeliveryPlan> = { phases: [] };

  interface OpenPhase {
    number: number;
    name: string;
    body: string[];
  }
  let open: OpenPhase | null = null;
  const flush = (): void => {
    if (!open) return;
    const tasks: DeliveryTask[] = [];
    const TASK_PATTERN = /^[ \t]*-[ \t]*\[(.)\][ \t]*\*\*(.+?)\*\*[ \t]*-[ \t]*(.+)$/;
    for (const line of open.body) {
      const tm = line.match(TASK_PATTERN);
      if (!tm) continue;
      tasks.push({
        id: `T${tasks.length + 1}`,
        title: tm[2]?.trim() ?? "",
        description: tm[3]?.trim() ?? "",
        effort: "m",
        phase: open.number,
        dependencies: [],
        status: tm[1] === "x" ? "done" : "pending",
      });
    }
    plan.phases?.push({
      number: open.number,
      name: open.name,
      tasks,
      duration: "TBD",
    });
    open = null;
  };

  for (const line of markdown.split("\n")) {
    // "### Phase" headings also open phases: the format emits h3, and the
    // original unanchored pattern matched them from offset 1.
    const phaseHeading = line.match(/^#{2,}[ \t]*phase[ \t]*(\d+)[ \t]*:[ \t]*(.*)$/i);
    if (phaseHeading) {
      flush();
      open = { number: parseInt(phaseHeading[1] ?? "0", 10), name: (phaseHeading[2] ?? "").trim(), body: [] };
      continue;
    }
    if (open && /^#{2,}[ \t]*rollback/i.test(line)) {
      flush();
      continue;
    }
    if (open) open.body.push(line);
  }
  flush();

  return plan;
}

export function formatPlan(plan: DeliveryPlan): string {
  return `# 📋 Delivery Plan — Proposal #${plan.proposalId}

**Created:** ${plan.createdAt}
**Estimated Duration:** ${plan.estimatedDuration}
**Branch Strategy:** \`${plan.branchStrategy}\`

## Phases
${plan.phases
  .map(
    (phase) => `### Phase ${phase.number}: ${phase.name} (${phase.duration})
${phase.tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] **${t.title}** — ${t.description} (${t.effort})`).join("\n")}
`,
  )
  .join("\n")}

## Rollback Plan
${plan.rollbackPlan}`;
}
