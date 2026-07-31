import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CreateProposalUseCase,
  handleDaoControl,
  handleDaoDeliberate,
  handleDaoDryRun,
  handleDaoPropose,
  handleDaoSetup,
  handleDaoShip,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { createSpawningHost, createWorkspace, proposalArgs, type Workspace } from "../support/fixtures.js";

describe("E2E: proposal lifecycle through the host-tool surface", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await createWorkspace("e2e");
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it("drives setup → propose → deliberate → control → ship and persists every transition", async () => {
    const host = createSpawningHost("pi", { workDir: workspace.dir });
    const ctx = workspace.context(host);

    const setup = await handleDaoSetup(ctx);
    expect(setup).toContain("DAO Initialized");
    expect(workspace.repository.get().agents.length).toBeGreaterThan(0);

    await handleDaoPropose(proposalArgs(), workspace.repository);
    const proposalId = workspace.repository.get().proposals[0]?.id;
    expect(proposalId).toBe(1);

    const deliberation = await handleDaoDeliberate(ctx, 1);
    expect(deliberation).not.toContain("Cannot deliberate");
    expect(workspace.repository.get().proposals[0]?.status).toBe("approved");
    expect(workspace.repository.get().proposals[0]?.votes).toHaveLength(workspace.repository.get().agents.length);

    const control = await handleDaoControl(ctx, 1);
    expect(control).toContain("ALL GATES PASSED");
    expect(workspace.repository.get().proposals[0]?.status).toBe("controlled");
    expect(workspace.repository.get().deliveryPlans[1]).toBeDefined();

    const ship = await handleDaoShip(ctx, 1);
    expect(ship).toContain("#1");
    expect(workspace.repository.get().proposals[0]?.status).toBe("executed");

    const reloaded = await workspace.reload();
    const persisted = reloaded.get();
    expect(persisted.proposals[0]?.status).toBe("executed");
    expect(persisted.snapshots[1]).toBeDefined();
    expect(persisted.auditLog.map((entry) => entry.action)).toContain("gates_passed");
    await fs.access(path.join(workspace.dir, ".dao", "state.json"));
  });

  it("blocks execution when the swarm rejects the proposal", async () => {
    const host = createSpawningHost("pi", {
      workDir: workspace.dir,
      replyFor: () => ({ vote: "against" }),
    });
    const ctx = workspace.context(host);

    await handleDaoSetup(ctx);
    await handleDaoPropose(proposalArgs(), workspace.repository);
    await handleDaoDeliberate(ctx, 1);

    expect(workspace.repository.get().proposals[0]?.status).toBe("rejected");
    expect(await handleDaoControl(ctx, 1)).toContain("Must be approved");
    expect(await handleDaoShip(ctx, 1)).toContain("Must be controlled");
  });

  it("keeps red-zone proposals behind the mandatory dry-run gate", async () => {
    const host = createSpawningHost("pi", { workDir: workspace.dir });
    const ctx = workspace.context(host);

    await handleDaoSetup(ctx);
    await handleDaoPropose(
      proposalArgs({ type: "security-change", affectedPaths: ["src/auth/session.ts"] }),
      workspace.repository,
    );
    await handleDaoDeliberate(ctx, 1);
    expect(workspace.repository.get().proposals[0]?.riskZone).toBe("red");

    const blocked = await handleDaoControl(ctx, 1);
    expect(blocked).toContain("GATES FAILED");
    expect(blocked).toContain("Dry-run required");
    expect(workspace.repository.get().proposals[0]?.status).toBe("approved");

    await handleDaoDryRun(1, workspace.repository);
    const passed = await handleDaoControl(ctx, 1);
    expect(passed).toContain("ALL GATES PASSED");
    expect(workspace.repository.get().proposals[0]?.status).toBe("controlled");
  });

  it("refuses to ship a proposal whose dependency is not executed", async () => {
    const host = createSpawningHost("pi", { workDir: workspace.dir });
    const ctx = workspace.context(host);

    await handleDaoSetup(ctx);
    await handleDaoPropose(proposalArgs({ title: "Base work" }), workspace.repository);
    await new CreateProposalUseCase({ repository: workspace.repository, clock: systemClock }).execute({
      ...proposalArgs({ title: "Dependent work" }),
      proposedBy: "user",
      dependsOn: [1],
    });

    await handleDaoDeliberate(ctx, 2);
    const control = await handleDaoControl(ctx, 2);
    expect(control).toContain("Unexecuted dependencies");

    const ship = await handleDaoShip(ctx, 2);
    expect(ship).toContain("unexecuted dependencies");
  });
});
