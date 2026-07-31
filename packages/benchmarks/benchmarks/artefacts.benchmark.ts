import {
  type DAOArtefacts,
  formatAllArtefacts,
  generateAllArtefacts,
  generateDecisionBrief,
  generateDeliveryPlan,
  type Proposal,
} from "@guyghost/swarm-dao-core";
import { deliberatedProposal } from "../src/fixtures.js";
import type { BenchmarkSuite } from "../src/harness.js";

let proposal: Proposal;
let batch: Proposal[];
let artefacts: DAOArtefacts;

/** Delivery artefact generation and markdown rendering. */
export const artefactsSuite: BenchmarkSuite = {
  name: "artefacts",
  iterations: 25,
  setup: () => {
    proposal = deliberatedProposal(1);
    batch = Array.from({ length: 10 }, (_unused, index) => deliberatedProposal(index + 1));
    artefacts = generateAllArtefacts(proposal);
  },
  cases: [
    {
      name: "decision brief",
      run: () => {
        generateDecisionBrief(proposal);
      },
    },
    {
      name: "all artefacts (7 documents)",
      run: () => {
        generateAllArtefacts(proposal);
      },
    },
    {
      name: "all artefacts × 10 proposals",
      run: () => {
        for (const candidate of batch) generateAllArtefacts(candidate);
      },
    },
    {
      name: "render artefacts to markdown",
      run: () => {
        formatAllArtefacts(artefacts);
      },
    },
    {
      name: "delivery plan",
      run: () => {
        generateDeliveryPlan(proposal, { now: "2031-01-01T00:00:00.000Z" });
      },
    },
  ],
};
