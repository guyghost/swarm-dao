import { beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addVote,
  createInitialState,
  createProposal,
  getAuditLog,
  getDaoRoot,
  getProposal,
  getState,
  getStorageSettings,
  initStorage,
  listProposals,
  loadState,
  padId,
  recordAudit,
  saveState,
  setState,
  updateProposalStatus,
  updateStorageSettings,
} from "@guyghost/swarm-dao-core";

describe("persistence", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    setState(state);
  });

  it("creates and retrieves proposals", async () => {
    const p1 = await createProposal("Feature A", "product-feature", "Add A", "user");
    expect(p1.id).toBe(1);

    const p2 = await createProposal("Feature B", "product-feature", "Add B", "user");
    expect(p2.id).toBe(2);

    expect(getProposal(1)?.title).toBe("Feature A");
    expect(listProposals().length).toBe(2);
  });

  it("adds votes", async () => {
    const p = await createProposal("Vote test", "product-feature", "Test", "user");
    await addVote(p.id, { agentId: "a", agentName: "A", position: "for", reasoning: "Yes", weight: 3 });
    expect(getProposal(p.id)?.votes.length).toBe(1);
  });

  it("updates proposal status", async () => {
    const p = await createProposal("Status test", "product-feature", "Test", "user");
    await updateProposalStatus(p.id, "executed");
    expect(getProposal(p.id)?.status).toBe("executed");
    expect(getProposal(p.id)?.resolvedAt).toBeDefined();
  });

  it("records audit entries", async () => {
    const p = await createProposal("Audit test", "product-feature", "Test", "user");
    await recordAudit(p.id, "governance", "test_action", "user", "details");
    const entries = getAuditLog(p.id);
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe("test_action");
  });

  it("pads IDs correctly", () => {
    expect(padId(1)).toBe("001");
    expect(padId(42)).toBe("042");
    expect(padId(999)).toBe("999");
  });

  it("returns dao root path", () => {
    expect(getDaoRoot("/project")).toBe("/project/.dao");
  });

  it("loadState repairs corrupted state.json missing proposals, agents, and auditLog", async () => {
    const cwd = `/tmp/dao-corruption-test-${Date.now()}`;

    try {
      // Create .dao/ directory
      await initStorage(cwd);

      // Write a malformed state.json missing proposals, agents, auditLog
      const corruptedState = {
        config: { quorumPercent: 60 },
        nextProposalId: 1,
        initialized: true,
        nextAuditId: 1,
        controlResults: {},
        deliveryPlans: {},
        artefacts: {},
        outcomes: {},
        snapshots: {},
        verifications: {},
        daoRoot: getDaoRoot(cwd),
      };
      const statePath = `${getDaoRoot(cwd)}/state.json`;
      await fs.writeFile(statePath, JSON.stringify(corruptedState), "utf-8");

      // Load the corrupted state
      const loaded = await loadState(cwd);
      expect(loaded).not.toBeNull();

      // Assert repaired arrays
      expect(getState().proposals).toEqual([]);
      expect(getState().agents).toEqual([]);
      expect(getState().auditLog).toEqual([]);
    } finally {
      // Clean up temp directory and reset state
      setState(null);
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── Storage Settings regression tests ──────────────────────────

  /**
   * OpenSpec Scenario: saveState writes state.json ending with a trailing newline
   *
   * GIVEN a DAO state with some data
   * WHEN saveState is called
   * THEN the written state.json file ends with a newline character
   */
  it("saveState writes state.json ending with a trailing newline", async () => {
    const cwd = `/tmp/dao-trailing-newline-test-${Date.now()}`;
    const daoRoot = getDaoRoot(cwd);

    try {
      await initStorage(cwd);
      const state = createInitialState(cwd);
      state.initialized = true;
      state.daoRoot = daoRoot;
      setState(state);

      // ACT: save state
      await saveState();

      // ASSERT: read the file and check trailing newline
      const statePath = path.join(daoRoot, "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      expect(content.endsWith("\n")).toBe(true);
    } finally {
      setState(null);
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * OpenSpec Scenario: getStorageSettings reads config.json and returns StorageSettings
   *
   * GIVEN a DAO root with a .dao/config.json containing valid StorageSettings
   * WHEN calling getStorageSettings(daoRoot) synchronously
   * THEN the returned value should be a plain StorageSettings object, not a Promise
   *   AND mode should equal "github" (before fix, it is undefined because the return
   *   is a Promise cast as StorageSettings)
   *
   * NOTE: After the fix, getStorageSettings becomes async. This test should be
   * updated to await the result. For now, it asserts the bug: sync access yields
   * undefined because the function silently returns a Promise.
   */
  it("getStorageSettings returns real StorageSettings, not a Promise cast", async () => {
    const cwd = `/tmp/dao-storage-settings-test-${Date.now()}`;
    const daoRoot = getDaoRoot(cwd);

    try {
      // ARRANGE: create .dao/ dir and write valid config.json
      await fs.mkdir(daoRoot, { recursive: true });
      const persisted = {
        mode: "github",
        githubSyncEnabled: true,
        daoRoot,
        githubRepo: "test/repo",
      };
      await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify(persisted, null, 2), "utf-8");

      // ACT: call async (fixed — was returning Promise cast as StorageSettings)
      const result = await getStorageSettings(daoRoot);

      // ASSERT: resolved value is a plain StorageSettings object
      expect(result).toMatchObject({
        mode: "github",
        githubSyncEnabled: true,
        githubRepo: "test/repo",
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * OpenSpec Scenario: updateStorageSettings persists and reads back correctly
   *
   * GIVEN an empty DAO root (no config.json yet)
   * WHEN calling updateStorageSettings with partial overrides
   * THEN getStorageSettings returns the merged values after the round-trip
   */
  it("updateStorageSettings round-trips with getStorageSettings", async () => {
    const cwd = `/tmp/dao-storage-roundtrip-test-${Date.now()}`;
    const daoRoot = getDaoRoot(cwd);

    try {
      // ACT: write settings via updateStorageSettings
      const written = await updateStorageSettings(daoRoot, {
        mode: "github",
        githubSyncEnabled: true,
        githubRepo: "roundtrip/repo",
      });

      // ASSERT: the returned object has the right values
      expect(written.mode).toBe("github");
      expect(written.githubSyncEnabled).toBe(true);
      expect(written.githubRepo).toBe("roundtrip/repo");

      // ACT: read them back
      const read = await getStorageSettings(daoRoot);

      // ASSERT: persisted values survive the round-trip
      expect(read.mode).toBe("github");
      expect(read.githubSyncEnabled).toBe(true);
      expect(read.githubRepo).toBe("roundtrip/repo");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });
});
