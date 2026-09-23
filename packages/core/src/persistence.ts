// ============================================================
// Swarm DAO Core — Persistence (.dao/ local file store)
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveConfigFilePath, resolveDaoLayout } from "./adapters/dao-home/dao-home.js";
import { withFileLock } from "./adapters/persistence/file-dao-state.repository.js";
import { commitMutation } from "./application/commit-mutation.js";
import { logger } from "./observability/logging.js";
import { recordVoteCast } from "./observability/metrics.js";
import type { DaoStateRepositoryPort } from "./ports/repository.js";
import type { AuditEntry, Proposal, ProposalOutcome, StorageSettings, Vote } from "./types/index.js";
import { redactSensitiveFields, SENSITIVE_KEYS } from "./utils/security.js";

const STATE_FILE = "state.json";
const DECISIONS_DIR = "decisions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  await writeAtomic(filePath, formatJson(value));
}

/**
 * Write `content` to `filePath` atomically: serialize to a sibling temp file,
 * then `rename` it over the target. POSIX `rename(2)` is atomic, so a reader
 * (or a crash at any instant) observes either the previous content or the new
 * content — never a partial write. The temp file lives in the same directory
 * to guarantee a same-filesystem rename.
 */
export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomToken()}`;
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await safeUnlink(tmpPath);
    throw error;
  }
}

function randomToken(): string {
  // Short, collision-resistant suffix for concurrent writers within one PID.
  return Math.random().toString(36).slice(2, 10);
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // Ignore — file may not exist or may already be gone.
  }
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

/**
 * Legacy synchronous mapping: `<cwd>/.dao`. Kept for compatibility callers
 * that cannot await; new code resolves through `resolveDaoLayout` (ADR-007),
 * which routes git repos to `~/.swarm-dao/<project>/branches/<branch>`.
 */
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
  // ADR-007: resolves legacy `.dao` or the external DAO home, ensures the
  // project manifest, and runs the passive GC sweep. Returns the state root
  // (branch dir in home mode).
  const layout = await resolveDaoLayout(cwd);
  await fs.mkdir(layout.stateRoot, { recursive: true });
  return layout.stateRoot;
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

// ── Storage Settings ─────────────────────────────────────────

export async function getStorageSettings(daoRoot: string): Promise<StorageSettings> {
  const configPath = await resolveConfigFilePath(daoRoot);
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
  const configPath = await resolveConfigFilePath(daoRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // Read-modify-write under the DAO lock (issue #167.4): otherwise a
  // concurrent config.json writer (e.g. saveGitHubConfigToDaoRoot) can drop
  // the storage update, or vice versa. The lock lives at the state root; a
  // project-root config shared across branches is not cross-branch locked in
  // v1 (ADR-007 — acceptable: config writes are rare and operator-driven).
  return withFileLock(daoRoot, async () => {
    const current = await getStorageSettings(daoRoot);
    const next = normalizeStorageSettings({ ...current, ...updates }, daoRoot);
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
  });
}

// ── Repository-scoped accessors ─────────────────────────

export function getProposalFrom(repository: DaoStateRepositoryPort, proposalId: number): Proposal | undefined {
  return repository.get().proposals.find((p) => p.id === proposalId);
}

export function listProposalsFrom(repository: DaoStateRepositoryPort): Proposal[] {
  return repository.get().proposals;
}

/** Default cap for a single vote's weight (issue #154): matches the heaviest
 *  default council agent weight. Configurable via `config.maxVoteWeight`. */
const DEFAULT_MAX_VOTE_WEIGHT = 3;

export type AddVoteResult = { ok: true; replaced: boolean } | { ok: false; error: string };

/**
 * Record a vote on a proposal (issue #154):
 * - a vote REPLACES any prior vote from the same agentId (same semantics as
 *   `mergeVotes` — one identity, one vote),
 * - votes are only accepted while the proposal is open or deliberating,
 * - the weight is bounded by `config.maxVoteWeight` (default 3).
 */
export async function addVoteOn(
  repository: DaoStateRepositoryPort,
  proposalId: number,
  vote: Vote,
): Promise<AddVoteResult> {
  const result = await commitMutation<AddVoteResult>(repository, async () => {
    const s = repository.get();
    const proposal = s.proposals.find((p) => p.id === proposalId);
    if (!proposal) return { persist: false, value: { ok: false, error: `Proposal #${proposalId} not found.` } };
    if (proposal.status !== "open" && proposal.status !== "deliberating") {
      return {
        persist: false,
        value: {
          ok: false,
          error: `Proposal #${proposalId} is "${proposal.status}"; votes are only accepted while open or deliberating.`,
        },
      };
    }
    const maxWeight = s.config.maxVoteWeight ?? DEFAULT_MAX_VOTE_WEIGHT;
    if (!Number.isFinite(vote.weight) || vote.weight <= 0) {
      return {
        persist: false,
        value: { ok: false, error: `Vote weight must be a positive number (got ${vote.weight}).` },
      };
    }
    if (vote.weight > maxWeight) {
      return {
        persist: false,
        value: { ok: false, error: `Vote weight ${vote.weight} exceeds the maximum allowed weight (${maxWeight}).` },
      };
    }
    const existingIndex = proposal.votes.findIndex((v) => v.agentId === vote.agentId);
    const replaced = existingIndex >= 0;
    if (replaced) proposal.votes[existingIndex] = vote;
    else proposal.votes.push(vote);
    return { persist: true, value: { ok: true, replaced } };
  });
  if (result.ok) recordVoteCast(vote.agentId, vote.position, vote.weight);
  return result;
}

// ── Audit ────────────────────────────────────────────────────

export async function recordAuditOn(
  repository: DaoStateRepositoryPort,
  proposalId: number,
  layer: AuditEntry["layer"],
  action: string,
  actor: string,
  details: string,
): Promise<void> {
  await commitMutation(repository, async () => {
    const s = repository.get();
    s.auditLog.push({
      id: s.nextAuditId++,
      timestamp: new Date().toISOString(),
      proposalId,
      layer,
      action,
      actor,
      details,
    });
    return { persist: true, value: undefined };
  });
}

export function getAuditLogFrom(repository: DaoStateRepositoryPort, proposalId: number): AuditEntry[] {
  return repository.get().auditLog.filter((e) => e.proposalId === proposalId);
}

export function getAllAuditLogFrom(repository: DaoStateRepositoryPort): AuditEntry[] {
  return repository.get().auditLog;
}

// ── Outcomes ─────────────────────────────────────────────────

export function getOutcomeFrom(repository: DaoStateRepositoryPort, proposalId: number): ProposalOutcome | undefined {
  return repository.get().outcomes[proposalId];
}

// Re-export types for convenience
export type { AgentOutput, Vote } from "./types/index.js";
