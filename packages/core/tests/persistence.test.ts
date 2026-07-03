import { beforeEach, describe, expect, it, spyOn } from "bun:test";
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
  migrateFromLegacy,
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
      expect(getState().controlResults).toEqual({});
      expect(getState().deliveryPlans).toEqual({});
      expect(getState().artefacts).toEqual({});
      expect(getState().outcomes).toEqual({});
      expect(getState().snapshots).toEqual({});
      expect(getState().verifications).toEqual({});
    } finally {
      // Clean up temp directory and reset state
      setState(null);
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("loadState repairs invalid collection shapes and non-positive IDs", async () => {
    const cwd = `/tmp/dao-corruption-shape-test-${Date.now()}`;

    try {
      await initStorage(cwd);

      const corruptedState = {
        proposals: {},
        agents: {},
        auditLog: {},
        config: { quorumPercent: 60 },
        nextProposalId: -5,
        initialized: true,
        nextAuditId: 0.5,
        controlResults: [],
        deliveryPlans: [],
        artefacts: [],
        outcomes: [],
        snapshots: [],
        verifications: [],
        daoRoot: getDaoRoot(cwd),
      };
      const statePath = `${getDaoRoot(cwd)}/state.json`;
      await fs.writeFile(statePath, JSON.stringify(corruptedState), "utf-8");

      const loaded = await loadState(cwd);
      expect(loaded).not.toBeNull();

      expect(getState().proposals).toEqual([]);
      expect(getState().agents).toEqual([]);
      expect(getState().auditLog).toEqual([]);
      expect(getState().controlResults).toEqual({});
      expect(getState().deliveryPlans).toEqual({});
      expect(getState().artefacts).toEqual({});
      expect(getState().outcomes).toEqual({});
      expect(getState().snapshots).toEqual({});
      expect(getState().verifications).toEqual({});
      expect(getState().nextProposalId).toBe(1);
      expect(getState().nextAuditId).toBe(1);
    } finally {
      setState(null);
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("migrateFromLegacy ignores unsafe legacy directory entries", async () => {
    const cwd = `/tmp/dao-legacy-safety-test-${Date.now()}`;
    const safeLegacy = ".legacy-dao";
    const safeLegacyRoot = path.join(cwd, safeLegacy);

    try {
      await fs.mkdir(safeLegacyRoot, { recursive: true });
      await fs.writeFile(path.join(safeLegacyRoot, "state.json"), JSON.stringify({ initialized: false }), "utf-8");

      const migrated = await migrateFromLegacy(cwd, ["", ".", "..", "../outside", "/tmp", safeLegacy]);
      expect(migrated).toBe(true);

      const migratedStatePath = path.join(getDaoRoot(cwd), "state.json");
      const content = await fs.readFile(migratedStatePath, "utf-8");
      expect(JSON.parse(content)).toMatchObject({ initialized: false });
    } finally {
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
   * Optimization guard: saveState() must not rewrite proposal sidecars or
   * decision files whose serialized content has not changed since the last save.
   *
   * GIVEN a DAO with resolved proposals (so sidecars + decision files exist)
   * WHEN saveState() is called without any prior mutation
   * THEN zero files are written (every JSON file is byte-identical to its cache)
   *   AND a subsequent mutation that only touches auditLog (state.json) writes
   *   exactly one file, not one-per-sidecar + one-per-decision.
   */
  it("saveState skips rewriting unchanged sidecars and decisions", async () => {
    const cwd = `/tmp/dao-writecache-test-${Date.now()}`;
    const daoRoot = getDaoRoot(cwd);

    try {
      await initStorage(cwd);
      const state = createInitialState(cwd);
      state.initialized = true;
      state.daoRoot = daoRoot;
      setState(state);

      // Seed proposals and resolve one so sidecars + decision files exist and
      // the write cache is populated with their current on-disk content.
      const p1 = await createProposal("P1", "product-feature", "d", "user");
      await createProposal("P2", "product-feature", "d", "user");
      await updateProposalStatus(p1.id, "executed");

      const writeSpy = spyOn(fs, "writeFile");

      // 1) No-op save: nothing changed since the previous save -> no writes.
      writeSpy.mockClear();
      await saveState();
      expect(writeSpy.mock.calls.length).toBe(0);

      // 2) Mutating save via recordAudit: only auditLog changes, which lives in
      //    state.json. Without dedup this rewrites state.json + every sidecar +
      //    every decision file; with dedup it writes just state.json.
      writeSpy.mockClear();
      await recordAudit(p1.id, "governance", "perf_probe", "user", "noop");
      expect(writeSpy.mock.calls.length).toBe(1);

      writeSpy.mockRestore();
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

  it("updateStorageSettings preserves existing integration config and isolates storage settings", async () => {
    const cwd = `/tmp/dao-storage-coexist-test-${Date.now()}`;
    const daoRoot = getDaoRoot(cwd);
    const configPath = path.join(daoRoot, "config.json");

    try {
      await fs.mkdir(daoRoot, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            github: {
              enabled: true,
              token: "token",
              owner: "owner",
              repo: "repo",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const written = await updateStorageSettings(daoRoot, { mode: "hybrid", githubSyncEnabled: true });
      expect(written.mode).toBe("hybrid");
      expect(written.githubSyncEnabled).toBe(true);

      const reloadedStorage = await getStorageSettings(daoRoot);
      expect(reloadedStorage.mode).toBe("hybrid");
      expect(reloadedStorage.githubSyncEnabled).toBe(true);

      const mergedConfig = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(mergedConfig.github?.repo).toBe("repo");
      expect(mergedConfig.storageSettings?.mode).toBe("hybrid");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });
});
