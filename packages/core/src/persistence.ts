// ============================================================
// Swarm DAO Core — Persistence (.dao/ local file store)
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { recordProposalExecuted, recordVoteCast } from "./observability/metrics.js";
import type {
  AgentOutput,
  AuditEntry,
  CompositeScore,
  ControlCheckResult,
  DAOAgent,
  DAOArtefacts,
  DAOState,
  DecisionRecord,
  DeliveryPlan,
  ExecutionSnapshot,
  ExecutionVerification,
  Proposal,
  ProposalOutcome,
  ProposalStatus,
  StorageSettings,
  Vote,
} from "./types/index.js";
import { createInitialState } from "./types/index.js";

let state: DAOState | null = null;

const STATE_FILE = "state.json";
const PROPOSALS_DIR = "proposals";
const DECISIONS_DIR = "decisions";
const CONFIG_FILE = "config.json";

// ── Paths ────────────────────────────────────────────────────

export function getDaoRoot(cwd: string): string {
  return path.join(cwd, ".dao");
}

export function getProposalsDir(daoRoot: string): string {
  return path.join(daoRoot, PROPOSALS_DIR);
}

export function getDecisionsDir(daoRoot: string): string {
  return path.join(daoRoot, DECISIONS_DIR);
}

export function padId(id: number): string {
  return id.toString().padStart(3, "0");
}

export function getProposalPath(daoRoot: string, id: number): string {
  return path.join(getProposalsDir(daoRoot), `${padId(id)}.json`);
}

// ── Storage Init ─────────────────────────────────────────────

export async function initStorage(cwd: string): Promise<string> {
  const daoRoot = getDaoRoot(cwd);
  await fs.mkdir(daoRoot, { recursive: true });
  return daoRoot;
}

// ── Legacy Migration ─────────────────────────────────────────

export async function migrateFromLegacy(cwd: string): Promise<boolean> {
  const legacyRoot = path.join(cwd, ".opencode-dao");
  const newRoot = getDaoRoot(cwd);

  try {
    await fs.access(newRoot);
    return false;
  } catch {
    /* .dao doesn't exist */
  }

  try {
    await fs.access(legacyRoot);
  } catch {
    return false;
  }

  console.log("🔄 Migrating DAO storage: .opencode-dao → .dao");
  await fs.mkdir(newRoot, { recursive: true });

  const entries = await fs.readdir(legacyRoot, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(legacyRoot, entry.name);
    const destPath = path.join(newRoot, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      const subEntries = await fs.readdir(srcPath);
      for (const subEntry of subEntries) {
        await fs.copyFile(path.join(srcPath, subEntry), path.join(destPath, subEntry));
      }
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }

  const oldStatePath = path.join(newRoot, "dao-state.json");
  const newStatePath = path.join(newRoot, STATE_FILE);
  try {
    await fs.access(oldStatePath);
    await fs.rename(oldStatePath, newStatePath);
    console.log("  ✓ Renamed dao-state.json → state.json");
  } catch {
    /* no old state */
  }

  // Migrate proposal IDs to 3-digit padding
  try {
    const proposalsDir = getProposalsDir(newRoot);
    const files = await fs.readdir(proposalsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const match = file.match(/^(\d+)\.json$/) ?? null;
      if (!match) continue;
      const id = parseInt(match[1] ?? "0", 10);
      const paddedName = `${padId(id)}.json`;
      if (file !== paddedName) {
        await fs.rename(path.join(proposalsDir, file), path.join(proposalsDir, paddedName));
        console.log(`  ✓ Renamed ${file} → ${paddedName}`);
      }
    }
  } catch {
    /* no proposals yet */
  }

  console.log("  ✓ Migration complete");
  try {
    await fs.rm(legacyRoot, { recursive: true, force: true });
    console.log("  ✓ Removed legacy .opencode-dao/");
  } catch (err) {
    console.warn("  ⚠ Could not remove .opencode-dao/:", err);
  }

  return true;
}

// ── State Access ─────────────────────────────────────────────

export function getState(): DAOState {
  if (!state) {
    throw new Error("DAO not initialized. Run dao_setup first.");
  }
  return state;
}

export function setState(newState: DAOState | null): void {
  state = newState;
}

export function getOrCreateState(cwd: string): DAOState {
  if (!state) {
    state = createInitialState(getDaoRoot(cwd));
  }
  return state;
}

// ── Load / Save ──────────────────────────────────────────────

export async function loadState(cwd: string): Promise<DAOState | null> {
  await migrateFromLegacy(cwd);
  const daoRoot = await initStorage(cwd);
  const statePath = path.join(daoRoot, STATE_FILE);

  let loaded: DAOState | null = null;
  try {
    const data = await fs.readFile(statePath, "utf-8");
    loaded = JSON.parse(data);
  } catch {
    return null;
  }
  if (!loaded) return null;

  // Ensure arrays exist (guard against corrupted/legacy state.json)
  if (!loaded.proposals) loaded.proposals = [];
  if (!loaded.agents) loaded.agents = [];
  if (!loaded.auditLog) loaded.auditLog = [];

  // Reconcile with sidecars
  try {
    const sidecars = await loadProposalsFromDisk(daoRoot);
    if (sidecars.length) {
      const byId = new Map<number, Proposal>();
      for (const p of loaded.proposals) byId.set(p.id, p);
      for (const sc of sidecars) byId.set(sc.id, sc);
      loaded.proposals = Array.from(byId.values()).sort((a, b) => a.id - b.id);
    }
  } catch {
    /* ignore */
  }

  state = loaded;
  return state;
}

export async function loadProposalsFromDisk(daoRoot: string): Promise<Proposal[]> {
  const dir = getProposalsDir(daoRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Proposal[] = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      const p = JSON.parse(raw) as Proposal;
      if (typeof p?.id === "number") out.push(p);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function saveProposal(proposalId: number): Promise<string | null> {
  if (!state) return null;
  const proposal = state.proposals.find((p) => p.id === proposalId);
  if (!proposal) return null;
  const dir = getProposalsDir(state.daoRoot);
  await fs.mkdir(dir, { recursive: true });
  const filePath = getProposalPath(state.daoRoot, proposalId);
  await fs.writeFile(filePath, `${JSON.stringify(proposal, null, 2)}\n`, "utf-8");
  return filePath;
}

export async function saveState(): Promise<void> {
  if (!state) return;
  if (!state.daoRoot) return;
  if (!state.proposals) state.proposals = [];
  const daoRoot = state.daoRoot;
  const statePath = path.join(daoRoot, STATE_FILE);

  await fs.mkdir(daoRoot, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

  // Sidecars
  const dir = getProposalsDir(daoRoot);
  try {
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      state.proposals.map((p) =>
        fs.writeFile(getProposalPath(daoRoot, p.id), `${JSON.stringify(p, null, 2)}\n`, "utf-8").catch(() => {}),
      ),
    );
  } catch {
    /* ignore */
  }

  await saveDecisions();

  // Cleanup orphans
  try {
    const entries = await fs.readdir(dir);
    const currentIds = new Set(state.proposals.map((p) => `${padId(p.id)}.json`));
    const orphans = entries.filter((e) => e.endsWith(".json") && !currentIds.has(e));
    for (const orphan of orphans) {
      try {
        await fs.unlink(path.join(dir, orphan));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ENOENT */
  }
}

export async function saveDecisions(): Promise<void> {
  if (!state?.daoRoot || !state.proposals) return;
  const decisionsDir = getDecisionsDir(state.daoRoot);
  await fs.mkdir(decisionsDir, { recursive: true });

  const resolved = state.proposals.filter((p) => p.status !== "open" && p.status !== "deliberating");
  const decisions = resolved
    .map(
      (p): DecisionRecord => ({
        id: p.id,
        title: p.title,
        type: p.type,
        status: p.status,
        riskZone: p.riskZone,
        createdAt: p.createdAt,
        resolvedAt: p.resolvedAt,
      }),
    )
    .sort((a, b) => a.id - b.id);

  await fs.writeFile(path.join(decisionsDir, "index.json"), `${JSON.stringify(decisions, null, 2)}\n`, "utf-8");
  await Promise.all(
    decisions.map((d) =>
      fs
        .writeFile(path.join(decisionsDir, `${padId(d.id)}.json`), `${JSON.stringify(d, null, 2)}\n`, "utf-8")
        .catch(() => {}),
    ),
  );
}

// ── Storage Settings ─────────────────────────────────────────

export async function getStorageSettings(daoRoot: string): Promise<StorageSettings> {
  const configPath = path.join(daoRoot, CONFIG_FILE);
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as StorageSettings;
  } catch {
    return { mode: "local", githubSyncEnabled: false, daoRoot };
  }
}

export async function updateStorageSettings(
  daoRoot: string,
  updates: Partial<StorageSettings>,
): Promise<StorageSettings> {
  const current = await getStorageSettings(daoRoot);
  const next = { ...current, ...updates };
  const configPath = path.join(daoRoot, CONFIG_FILE);
  await fs.mkdir(daoRoot, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

// ── Agent CRUD ───────────────────────────────────────────────

export async function addAgent(agent: DAOAgent): Promise<void> {
  const s = getState();
  s.agents.push(agent);
  await saveState();
}

export async function removeAgent(agentId: string): Promise<boolean> {
  const s = getState();
  const index = s.agents.findIndex((a) => a.id === agentId);
  if (index === -1) return false;
  s.agents.splice(index, 1);
  await saveState();
  return true;
}

export function getAgent(agentId: string): DAOAgent | undefined {
  return getState().agents.find((a) => a.id === agentId);
}

export function listAgents(): DAOAgent[] {
  return getState().agents;
}

// ── Proposal CRUD ────────────────────────────────────────────

export async function createProposal(
  title: string,
  type: string,
  description: string,
  proposedBy: string,
  context?: string,
): Promise<Proposal> {
  const s = getState();
  const proposal: Proposal = {
    id: s.nextProposalId++,
    title,
    type: type as Proposal["type"],
    description,
    context,
    proposedBy,
    status: "open",
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
  };
  s.proposals.push(proposal);
  await saveState();
  return proposal;
}

export function getProposal(proposalId: number): Proposal | undefined {
  return getState().proposals.find((p) => p.id === proposalId);
}

export function listProposals(): Proposal[] {
  return getState().proposals;
}

export async function updateProposalStatus(proposalId: number, status: ProposalStatus): Promise<boolean> {
  const s = getState();
  const proposal = s.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;
  proposal.status = status;
  if (status === "executed" || status === "rejected" || status === "failed") {
    proposal.resolvedAt = new Date().toISOString();
  }
  if (status === "executed") {
    recordProposalExecuted(proposal.id, proposal.type);
  }
  await saveState();
  return true;
}

export async function addVote(proposalId: number, vote: Vote): Promise<boolean> {
  const s = getState();
  const proposal = s.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;
  proposal.votes.push(vote);
  recordVoteCast(vote.agentId, vote.position, vote.weight);
  await saveState();
  return true;
}

export async function storeAgentOutput(proposalId: number, output: AgentOutput): Promise<boolean> {
  const s = getState();
  const proposal = s.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;
  proposal.agentOutputs.push(output);
  await saveState();
  return true;
}

export async function storeSynthesis(proposalId: number, synthesis: string): Promise<boolean> {
  const s = getState();
  const proposal = s.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;
  proposal.synthesis = synthesis;
  await saveState();
  return true;
}

export async function storeCompositeScore(proposalId: number, score: CompositeScore | undefined): Promise<boolean> {
  const s = getState();
  const proposal = s.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;
  proposal.compositeScore = score;
  await saveState();
  return true;
}

export async function storeControlResult(proposalId: number, result: ControlCheckResult): Promise<void> {
  const s = getState();
  s.controlResults[proposalId] = result;
  await saveState();
}

export function getControlResult(proposalId: number): ControlCheckResult | undefined {
  return getState().controlResults[proposalId];
}

export async function storeDeliveryPlan(proposalId: number, plan: DeliveryPlan): Promise<void> {
  const s = getState();
  s.deliveryPlans[proposalId] = plan;
  await saveState();
}

export function getDeliveryPlan(proposalId: number): DeliveryPlan | undefined {
  return getState().deliveryPlans[proposalId];
}

// ── Audit ────────────────────────────────────────────────────

export async function recordAudit(
  proposalId: number,
  layer: AuditEntry["layer"],
  action: string,
  actor: string,
  details: string,
): Promise<void> {
  const s = getState();
  s.auditLog.push({
    id: s.nextAuditId++,
    timestamp: new Date().toISOString(),
    proposalId,
    layer,
    action,
    actor,
    details,
  });
  await saveState();
}

export function getAuditLog(proposalId: number): AuditEntry[] {
  return getState().auditLog.filter((e) => e.proposalId === proposalId);
}

export function getAllAuditLog(): AuditEntry[] {
  return getState().auditLog;
}

// ── Outcomes ─────────────────────────────────────────────────

export function getOutcome(proposalId: number): ProposalOutcome | undefined {
  return getState().outcomes[proposalId];
}

export async function initOutcome(proposalId: number): Promise<ProposalOutcome> {
  const s = getState();
  const existing = s.outcomes[proposalId];
  if (existing) return existing;
  const outcome: ProposalOutcome = {
    proposalId,
    ratings: [],
    metrics: [],
    overallScore: 0,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  s.outcomes[proposalId] = outcome;
  await saveState();
  return outcome;
}

export async function addRating(proposalId: number, rating: ProposalOutcome["ratings"][0]): Promise<void> {
  const outcome = await initOutcome(proposalId);
  outcome.ratings.push(rating);
  const scores = outcome.ratings.map((r) => r.score);
  outcome.overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  outcome.updatedAt = new Date().toISOString();
  await saveState();
}

export async function addMetric(proposalId: number, metric: ProposalOutcome["metrics"][0]): Promise<void> {
  const outcome = await initOutcome(proposalId);
  outcome.metrics.push(metric);
  outcome.updatedAt = new Date().toISOString();
  await saveState();
}

export async function markReviewed(proposalId: number): Promise<void> {
  const outcome = await initOutcome(proposalId);
  outcome.status = "reviewed";
  outcome.updatedAt = new Date().toISOString();
  await saveState();
}

// ── Snapshots ────────────────────────────────────────────────

export async function captureSnapshot(proposalId: number, snapshot: ExecutionSnapshot): Promise<void> {
  const s = getState();
  s.snapshots[proposalId] = snapshot;
  await saveState();
}

export function getSnapshot(proposalId: number): ExecutionSnapshot | undefined {
  return getState().snapshots[proposalId];
}

// ── Verification ─────────────────────────────────────────────

export async function storeVerification(proposalId: number, verification: ExecutionVerification): Promise<void> {
  const s = getState();
  s.verifications[proposalId] = verification;
  await saveState();
}

export function getVerification(proposalId: number): ExecutionVerification | undefined {
  return getState().verifications[proposalId];
}

// ── Artefacts ────────────────────────────────────────────────

export async function storeArtefacts(proposalId: number, artefacts: DAOArtefacts): Promise<void> {
  const s = getState();
  s.artefacts[proposalId] = artefacts;
  await saveState();
}

export function getArtefacts(proposalId: number): DAOArtefacts | undefined {
  return getState().artefacts[proposalId];
}

// Re-export types for convenience
export type { AgentOutput, Vote } from "./types/index.js";
