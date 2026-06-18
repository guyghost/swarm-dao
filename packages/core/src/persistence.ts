// ============================================================
// Swarm DAO Core — Persistence (.dao/ local file store)
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./observability/logging.js";
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
import { redactSensitiveFields, SENSITIVE_KEYS } from "./utils/security.js";

let state: DAOState | null = null;

const STATE_FILE = "state.json";
const PROPOSALS_DIR = "proposals";
const DECISIONS_DIR = "decisions";
const CONFIG_FILE = "config.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const key of SENSITIVE_KEYS) {
    const escapedKey = escapeRegExp(key);
    const keyPattern = `(?:"|')?\\b${escapedKey}\\b(?:"|')?`;
    const separatorPattern = "\\s*(?:=|:)\\s*";
    const quotedValuePattern = `"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'`;
    const bareValuePattern = "[^\\s,}\\];)\\]]+";
    const regex = new RegExp(`(${keyPattern}${separatorPattern})(${quotedValuePattern}|${bareValuePattern})`, "gi");
    sanitized = sanitized.replace(regex, (_match, prefix: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return quote ? `${prefix}${quote}[REDACTED]${quote}` : `${prefix}[REDACTED]`;
    });
  }
  return sanitized;
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(message);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === code
  );
}

function parseJsonText<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${context}: ${getErrorMessage(error)}`);
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseJsonText<T>(raw, filePath);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, formatJson(value), "utf-8");
}

function normalizeStorageSettings(value: unknown, daoRoot: string): StorageSettings {
  const settings = isRecord(value) ? value : {};
  const mode = settings.mode;
  const githubSyncEnabled = settings.githubSyncEnabled;
  const githubRepo = settings.githubRepo;
  const next: StorageSettings = {
    mode: mode === "local" || mode === "github" || mode === "hybrid" ? mode : "local",
    githubSyncEnabled: typeof githubSyncEnabled === "boolean" ? githubSyncEnabled : false,
    daoRoot: typeof settings.daoRoot === "string" ? settings.daoRoot : daoRoot,
  };
  if (typeof githubRepo === "string") {
    next.githubRepo = githubRepo;
  }
  return next;
}

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

function resolveSafeLegacyDirectory(cwd: string, directory: string): string | null {
  const trimmed = directory.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  if (path.isAbsolute(trimmed)) return null;
  if (trimmed.includes(path.sep) || trimmed.includes("/") || trimmed.includes("\\")) return null;

  const resolvedCwd = path.resolve(cwd);
  const candidate = path.resolve(resolvedCwd, trimmed);
  const relative = path.relative(resolvedCwd, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

// ── Storage Init ─────────────────────────────────────────────

export async function initStorage(cwd: string): Promise<string> {
  const daoRoot = getDaoRoot(cwd);
  await fs.mkdir(daoRoot, { recursive: true });
  return daoRoot;
}

// ── Legacy Migration ─────────────────────────────────────────

async function findLegacyRoot(cwd: string, legacyDirectories: string[]): Promise<string | null> {
  for (const directory of legacyDirectories) {
    const candidate = resolveSafeLegacyDirectory(cwd, directory);
    if (!candidate) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* candidate doesn't exist */
    }
  }
  return null;
}

async function copyLegacyFiles(legacyRoot: string, newRoot: string): Promise<void> {
  const entries = await fs.readdir(legacyRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(legacyRoot, entry.name);
      const destPath = path.join(newRoot, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        const subEntries = await fs.readdir(srcPath);
        await Promise.all(
          subEntries.map((subEntry) => fs.copyFile(path.join(srcPath, subEntry), path.join(destPath, subEntry))),
        );
        return;
      }
      await fs.copyFile(srcPath, destPath);
    }),
  );
}

async function migrateProposalIdPaddings(newRoot: string): Promise<void> {
  try {
    const proposalsDir = getProposalsDir(newRoot);
    const files = await fs.readdir(proposalsDir);
    await Promise.all(
      files.map(async (file) => {
        if (!file.endsWith(".json")) return;
        const match = file.match(/^(\d+)\.json$/) ?? null;
        if (!match) return;
        const id = parseInt(match[1] ?? "0", 10);
        const paddedName = `${padId(id)}.json`;
        if (file !== paddedName) {
          await fs.rename(path.join(proposalsDir, file), path.join(proposalsDir, paddedName));
          logger.info(`  ✓ Renamed ${file} → ${paddedName}`);
        }
      }),
    );
  } catch {
    /* no proposals yet */
  }
}

export async function migrateFromLegacy(cwd: string, legacyDirectories: string[] = []): Promise<boolean> {
  const newRoot = getDaoRoot(cwd);

  try {
    await fs.access(newRoot);
    return false;
  } catch {
    /* .dao doesn't exist */
  }

  const legacyRoot = await findLegacyRoot(cwd, legacyDirectories);
  if (!legacyRoot) {
    return false;
  }

  logger.info("🔄 Migrating DAO storage: legacy directory → .dao");
  await fs.mkdir(newRoot, { recursive: true });

  await copyLegacyFiles(legacyRoot, newRoot);

  const oldStatePath = path.join(newRoot, "dao-state.json");
  const newStatePath = path.join(newRoot, STATE_FILE);
  try {
    await fs.access(oldStatePath);
    await fs.rename(oldStatePath, newStatePath);
    logger.info("  ✓ Renamed dao-state.json → state.json");
  } catch {
    /* no old state */
  }

  await migrateProposalIdPaddings(newRoot);

  logger.info("  ✓ Migration complete");
  try {
    await fs.rm(legacyRoot, { recursive: true, force: true });
    logger.info("  ✓ Removed legacy DAO directory");
  } catch (err) {
    logger.warn("  ⚠ Could not remove legacy DAO directory:", err);
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

export async function loadState(cwd: string, options?: { legacyDirectories?: string[] }): Promise<DAOState | null> {
  await migrateFromLegacy(cwd, options?.legacyDirectories ?? []);
  const daoRoot = await initStorage(cwd);
  const statePath = path.join(daoRoot, STATE_FILE);

  let loaded: DAOState | null = null;
  try {
    loaded = await readJsonFile<DAOState>(statePath);
  } catch {
    return null;
  }
  if (!loaded) return null;

  // Ensure state shape exists (guard against corrupted/legacy state.json)
  if (!Array.isArray(loaded.proposals)) loaded.proposals = [];
  if (!Array.isArray(loaded.agents)) loaded.agents = [];
  if (!Array.isArray(loaded.auditLog)) loaded.auditLog = [];
  if (!isRecord(loaded.controlResults)) loaded.controlResults = {};
  if (!isRecord(loaded.deliveryPlans)) loaded.deliveryPlans = {};
  if (!isRecord(loaded.artefacts)) loaded.artefacts = {};
  if (!isRecord(loaded.outcomes)) loaded.outcomes = {};
  if (!isRecord(loaded.snapshots)) loaded.snapshots = {};
  if (!isRecord(loaded.verifications)) loaded.verifications = {};
  if (!loaded.daoRoot) loaded.daoRoot = daoRoot;
  if (!isPositiveInteger(loaded.nextProposalId)) loaded.nextProposalId = 1;
  if (!isPositiveInteger(loaded.nextAuditId)) loaded.nextAuditId = 1;
  if (!loaded.config) loaded.config = createInitialState(daoRoot).config;

  // Reconcile with sidecars
  try {
    const persistedProposals = loaded.proposals.filter((proposal): proposal is Proposal =>
      isPositiveInteger((proposal as { id?: unknown })?.id),
    );
    loaded.proposals = persistedProposals;
    const sidecars = await loadProposalsFromDisk(daoRoot);
    if (sidecars.length) {
      const byId = new Map<number, Proposal>();
      for (const p of persistedProposals) byId.set(p.id, p);
      for (const sc of sidecars) byId.set(sc.id, sc);
      loaded.proposals = Array.from(byId.values()).sort((a, b) => a.id - b.id);
    }
  } catch (error) {
    logger.warn(`⚠ Failed to reconcile proposal sidecars: ${getErrorMessage(error)}`);
  }

  const highestProposalId = loaded.proposals.reduce((max, proposal) => Math.max(max, proposal.id), 0);
  if (loaded.nextProposalId <= highestProposalId) loaded.nextProposalId = highestProposalId + 1;
  const highestAuditId = loaded.auditLog.reduce((max, entry) => {
    const id = (entry as { id?: unknown })?.id;
    return isPositiveInteger(id) ? Math.max(max, id) : max;
  }, 0);
  if (loaded.nextAuditId <= highestAuditId) loaded.nextAuditId = highestAuditId + 1;

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
  const proposals = await Promise.all(
    entries
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const filePath = path.join(dir, file);
        try {
          const proposal = await readJsonFile<Proposal>(filePath);
          return isPositiveInteger(proposal?.id) ? proposal : null;
        } catch (error) {
          logger.warn(`⚠ Skipping malformed proposal sidecar ${filePath}: ${getErrorMessage(error)}`);
          return null;
        }
      }),
  );
  return proposals.filter((proposal): proposal is Proposal => proposal !== null);
}

export async function saveProposal(proposalId: number): Promise<string | null> {
  if (!state) return null;
  const proposal = state.proposals.find((p) => p.id === proposalId);
  if (!proposal) return null;
  const dir = getProposalsDir(state.daoRoot);
  await fs.mkdir(dir, { recursive: true });
  const filePath = getProposalPath(state.daoRoot, proposalId);
  await writeJsonFile(filePath, proposal);
  return filePath;
}

export async function saveState(): Promise<void> {
  if (!state) return;
  if (!state.daoRoot) return;
  if (!state.proposals) state.proposals = [];
  const daoRoot = state.daoRoot;
  const statePath = path.join(daoRoot, STATE_FILE);

  await fs.mkdir(daoRoot, { recursive: true });
  await writeJsonFile(statePath, state);

  // Sidecars
  const dir = getProposalsDir(daoRoot);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(state.proposals.map((proposal) => writeJsonFile(getProposalPath(daoRoot, proposal.id), proposal)));

  await saveDecisions();

  // Cleanup orphans
  try {
    const entries = await fs.readdir(dir);
    const currentIds = new Set(state.proposals.map((p) => `${padId(p.id)}.json`));
    const orphans = entries.filter((e) => e.endsWith(".json") && !currentIds.has(e));
    await Promise.all(
      orphans.map(async (orphan) => {
        const orphanPath = path.join(dir, orphan);
        try {
          await fs.unlink(orphanPath);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) return;
          logger.warn(`⚠ Failed to remove orphan proposal sidecar ${orphanPath}: ${getErrorMessage(error)}`);
        }
      }),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
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

  await writeJsonFile(path.join(decisionsDir, "index.json"), decisions);
  await Promise.all(
    decisions.map((decision) => writeJsonFile(path.join(decisionsDir, `${padId(decision.id)}.json`), decision)),
  );
}

// ── Storage Settings ─────────────────────────────────────────

export async function getStorageSettings(daoRoot: string): Promise<StorageSettings> {
  const configPath = path.join(daoRoot, CONFIG_FILE);
  try {
    const parsed = await readJsonFile<unknown>(configPath);
    if (isRecord(parsed) && isRecord(parsed.storageSettings)) {
      return normalizeStorageSettings(parsed.storageSettings, daoRoot);
    }
    return normalizeStorageSettings(parsed, daoRoot);
  } catch {
    return { mode: "local", githubSyncEnabled: false, daoRoot };
  }
}

export async function updateStorageSettings(
  daoRoot: string,
  updates: Partial<StorageSettings>,
): Promise<StorageSettings> {
  const current = await getStorageSettings(daoRoot);
  const next = normalizeStorageSettings({ ...current, ...updates }, daoRoot);
  const configPath = path.join(daoRoot, CONFIG_FILE);
  await fs.mkdir(daoRoot, { recursive: true });
  let rootConfig: Record<string, unknown> = {};
  try {
    const parsed = await readJsonFile<unknown>(configPath);
    if (isRecord(parsed)) {
      rootConfig = parsed;
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      logger.warn(`⚠ Ignoring invalid storage config at ${configPath}: ${getErrorMessage(error)}`);
    }
  }
  rootConfig.storageSettings = next;
  const redacted = redactSensitiveFields(rootConfig);
  await writeJsonFile(configPath, redacted);
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

export async function createProposalsBatch(
  entries: Array<{
    title: string;
    type: string;
    description: string;
    proposedBy: string;
    context?: string;
  }>,
): Promise<Proposal[]> {
  if (entries.length === 0) return [];
  const s = getState();
  const proposals = entries.map((entry) => {
    const proposal: Proposal = {
      id: s.nextProposalId++,
      title: entry.title,
      type: entry.type as Proposal["type"],
      description: entry.description,
      context: entry.context,
      proposedBy: entry.proposedBy,
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    return proposal;
  });
  s.proposals.push(...proposals);
  await saveState();
  return proposals;
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

export async function storeDeliberationBatch(
  proposalId: number,
  votes: Vote[],
  outputs: AgentOutput[],
): Promise<boolean> {
  const s = getState();
  const proposal = s.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;
  for (const vote of votes) {
    proposal.votes.push(vote);
    recordVoteCast(vote.agentId, vote.position, vote.weight);
  }
  proposal.agentOutputs.push(...outputs);
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
