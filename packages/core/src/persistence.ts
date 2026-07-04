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
const DECISIONS_DIR = "decisions";
const CONFIG_FILE = "config.json";

/**
 * Name of the now-removed per-proposal sidecar directory. Kept only for the
 * one-time import in `importLegacyProposalSidecars`; never written.
 */
const LEGACY_PROPOSALS_DIR = "proposals";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Precompiled redaction patterns, one per key in `SENSITIVE_KEYS`.
 *
 * The previous implementation rebuilt up to five `RegExp` objects (one per
 * sensitive key) on *every* `sanitizeErrorMessage` call, even though the
 * pattern string for a given key is constant. We now compile each combined
 * regex exactly once at module load and reuse it.
 *
 * Each regex carries the `g` flag, so a single `String.prototype.replace`
 * call replaces every occurrence of that key in the message — identical to the
 * previous per-call behavior. For global regexes, `String.prototype.replace`
 * resets `lastIndex` to 0 before returning, so the compiled global regexes are
 * safe to reuse across calls.
 */
const SENSITIVE_REDACT_PATTERNS: ReadonlyArray<RegExp> = Array.from(SENSITIVE_KEYS).map((key) => {
  const escapedKey = escapeRegExp(key);
  const keyPattern = `(?:"|')?\\b${escapedKey}\\b(?:"|')?`;
  const separatorPattern = "\\s*(?:=|:)\\s*";
  const quotedValuePattern = `"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'`;
  const bareValuePattern = "[^\\s,}\\];)\\]]+";
  return new RegExp(`(${keyPattern}${separatorPattern})(${quotedValuePattern}|${bareValuePattern})`, "gi");
});

export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const regex of SENSITIVE_REDACT_PATTERNS) {
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
  } catch (_error) {
    throw new Error(`Invalid JSON in ${context}`);
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

/**
 * In-memory cache of the last serialized content written per file path.
 *
 * `saveState()` is invoked on essentially every mutation (add a vote, store an
 * agent output, record audit, store a score/synthesis/plan, ...). Each call
 * rewrites `state.json` and every decision file. On the deliberation hot path
 * this happens ~6 times back-to-back, and only a tiny fraction of that data
 * actually changes between calls — so most of those writes re-serialize
 * byte-identical content.
 *
 * `writeJsonFileIfChanged` skips the disk write when the serialized content
 * matches the last write for that path. This is purely an I/O optimization:
 * the bytes that do reach disk are identical to before.
 *
 * Correctness: the cache is cleared whenever the in-memory state is swapped
 * (`setState`) or reloaded from disk (`loadState`), so the first save after a
 * swap always performs a full, correct write. The only writers of these files
 * are the save functions themselves, so a cached "unchanged" decision always
 * reflects what is actually on disk within a session.
 */
const writeCache = new Map<string, string>();

function resetWriteCache(): void {
  writeCache.clear();
}

async function writeJsonFileIfChanged(filePath: string, value: unknown): Promise<boolean> {
  const serialized = formatJson(value);
  if (writeCache.get(filePath) === serialized) return false;
  await fs.writeFile(filePath, serialized, "utf-8");
  writeCache.set(filePath, serialized);
  return true;
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

export function getDecisionsDir(daoRoot: string): string {
  return path.join(daoRoot, DECISIONS_DIR);
}

export function padId(id: number): string {
  return id.toString().padStart(3, "0");
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
  // The in-memory state identity changed (or was reset); the write cache no
  // longer reflects what is on disk, so force the next save to be a full write.
  resetWriteCache();
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

  // Drop any entries without a positive-integer id (defensive shape check).
  loaded.proposals = loaded.proposals.filter((proposal): proposal is Proposal =>
    isPositiveInteger((proposal as { id?: unknown })?.id),
  );
  // One-time import of any legacy per-proposal sidecars, then remove the now-
  // dead proposals/ directory. After this, state.json is the single source of
  // truth for proposals.
  await importLegacyProposalSidecars(daoRoot, loaded);

  const highestProposalId = loaded.proposals.reduce((max, proposal) => Math.max(max, proposal.id), 0);
  if (loaded.nextProposalId <= highestProposalId) loaded.nextProposalId = highestProposalId + 1;
  const highestAuditId = loaded.auditLog.reduce((max, entry) => {
    const id = (entry as { id?: unknown })?.id;
    return isPositiveInteger(id) ? Math.max(max, id) : max;
  }, 0);
  if (loaded.nextAuditId <= highestAuditId) loaded.nextAuditId = highestAuditId + 1;

  state = loaded;
  // Disk is now the source of truth for the freshly loaded state; reset the
  // cache so the first subsequent save reflects the real on-disk content.
  resetWriteCache();
  return state;
}

/**
 * One-time migration: import any legacy `.dao/proposals/NNN.json` sidecars that
 * are missing from state.json, then remove the now-dead proposals/ directory.
 *
 * Sidecars were a redundant per-proposal copy of data already held in state.json
 * and have been removed. After this runs (a no-op when no proposals/ dir exists),
 * no sidecar code path remains and state.json is the single source of truth.
 */
async function importLegacyProposalSidecars(daoRoot: string, loaded: DAOState): Promise<void> {
  const dir = path.join(daoRoot, LEGACY_PROPOSALS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // no legacy sidecar directory
  }
  const existingIds = new Set(loaded.proposals.map((p) => p.id));
  let imported = 0;
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    try {
      const proposal = await readJsonFile<Proposal>(filePath);
      if (isPositiveInteger(proposal?.id) && !existingIds.has(proposal.id)) {
        loaded.proposals.push(proposal);
        imported++;
      }
    } catch (error) {
      logger.warn(`⚠ Skipping malformed legacy proposal sidecar ${filePath}: ${getErrorMessage(error)}`);
    }
  }
  if (imported > 0) {
    logger.info(`🔄 Imported ${imported} proposal(s) from legacy sidecars into state.json`);
    loaded.proposals.sort((a, b) => a.id - b.id);
  }
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn(`⚠ Could not remove legacy proposals directory: ${getErrorMessage(error)}`);
  }
}

export async function saveState(): Promise<void> {
  if (!state) return;
  if (!state.daoRoot) return;
  if (!state.proposals) state.proposals = [];
  const daoRoot = state.daoRoot;
  const statePath = path.join(daoRoot, STATE_FILE);

  await fs.mkdir(daoRoot, { recursive: true });
  await writeJsonFileIfChanged(statePath, state);

  await saveDecisions();
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

  await writeJsonFileIfChanged(path.join(decisionsDir, "index.json"), decisions);
  await Promise.all(
    decisions.map((decision) =>
      writeJsonFileIfChanged(path.join(decisionsDir, `${padId(decision.id)}.json`), decision),
    ),
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
