import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASELINE_EFFECT_ID = "baseline";

export type StagedArtifact = Readonly<{
  hash: string;
  dataBase64: string;
}>;

export type StageInspection = Readonly<{
  activeHash: string | null;
  previousHash: string | null;
  activatedAt: string;
  effectId: string;
  intact: boolean;
  issue?: string;
}>;

export type StageRollbackPathVerification = Readonly<{
  restorable: boolean;
  activeHash: string | null;
  rollbackHash: string | null;
  evidence: string;
}>;

export type StageShipResult = Readonly<{
  effectId: string;
  artifactHash: string;
  previousHash: string | null;
}>;

export type StageRollbackResult = Readonly<{
  effectId: string;
  restoredHash: string | null;
}>;

export type LocalStagingTargetOptions = Readonly<{
  stageRoot: string;
  snapshotSource: () => Promise<string | Uint8Array>;
  clock?: () => string;
}>;

type ActivePointer = Readonly<{
  version: 1;
  activeHash: string | null;
  activatedAt: string;
  effectId: string;
  rollbackTarget: ActivePointer | null;
}>;

type StageEffect = Readonly<{
  version: 1;
  effectId: string;
  operation: "ship" | "rollback";
  status: "pending" | "completed";
  before: ActivePointer;
  after: ActivePointer;
  artifactHash?: string;
  expectedActiveHash?: string;
  result: StageShipResult | StageRollbackResult;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHash = (value: unknown): value is string => typeof value === "string" && HASH_PATTERN.test(value);

const isNotFound = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT";

const toBytes = (artifact: StagedArtifact): Buffer => {
  if (!isHash(artifact.hash) || typeof artifact.dataBase64 !== "string") {
    throw new Error("staged artifact has an invalid hash or byte encoding");
  }
  const bytes = Buffer.from(artifact.dataBase64, "base64");
  if (bytes.toString("base64") !== artifact.dataBase64) throw new Error("staged artifact base64 is not canonical");
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== artifact.hash) throw new Error("staged artifact content does not match its SHA-256 hash");
  return bytes;
};

const parsePointer = (value: unknown, depth = 0): ActivePointer => {
  if (
    depth > 128 ||
    !isRecord(value) ||
    value.version !== 1 ||
    !isHashOrNull(value.activeHash) ||
    typeof value.activatedAt !== "string" ||
    Number.isNaN(Date.parse(value.activatedAt))
  ) {
    throw new Error("active staging pointer is malformed");
  }
  if (typeof value.effectId !== "string" || value.effectId.length === 0) {
    throw new Error("active staging pointer is missing its effect ID");
  }
  return {
    version: 1,
    activeHash: value.activeHash,
    activatedAt: value.activatedAt,
    effectId: value.effectId,
    rollbackTarget: value.rollbackTarget === null ? null : parsePointer(value.rollbackTarget, depth + 1),
  };
};

const isHashOrNull = (value: unknown): value is string | null => value === null || isHash(value);

const samePointer = (left: ActivePointer, right: ActivePointer): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createLocalStagingTarget = (options: LocalStagingTargetOptions) => {
  const stageRoot = resolve(options.stageRoot);
  const clock = options.clock ?? (() => new Date().toISOString());
  const artifactDirectory = resolve(stageRoot, "artifacts");
  const effectDirectory = resolve(stageRoot, "effects");
  const pointerPath = resolve(stageRoot, "active.json");
  let tail: Promise<void> = Promise.resolve();

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const effectPath = (effectId: string): string => {
    if (typeof effectId !== "string" || effectId.trim().length === 0 || effectId.length > 512) {
      throw new Error("staging effect ID must be a non-empty value of at most 512 characters");
    }
    const name = createHash("sha256").update(effectId).digest("hex");
    return resolve(effectDirectory, `${name}.json`);
  };

  const writeAtomic = async (path: string, content: string | Uint8Array): Promise<void> => {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, content, { flag: "wx" });
    await rename(temporaryPath, path);
  };

  const readPointer = async (): Promise<ActivePointer> => {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(pointerPath, "utf8"));
    } catch (error) {
      if (isNotFound(error)) throw new Error("active staging pointer has not been initialized");
      if (error instanceof SyntaxError) throw new Error("active staging pointer is invalid JSON");
      throw error;
    }
    return parsePointer(value);
  };

  const writePointer = async (pointer: ActivePointer): Promise<void> => {
    await writeAtomic(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  };

  const readEffect = async (effectId: string): Promise<StageEffect | null> => {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(effectPath(effectId), "utf8"));
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof SyntaxError) throw new Error(`staging effect ${effectId} has invalid JSON`);
      throw error;
    }
    if (!isRecord(value) || value.version !== 1 || value.effectId !== effectId) {
      throw new Error(`staging effect ${effectId} is malformed`);
    }
    parsePointer(value.before);
    parsePointer(value.after);
    if (
      (value.operation !== "ship" && value.operation !== "rollback") ||
      (value.status !== "pending" && value.status !== "completed") ||
      !isRecord(value.result)
    ) {
      throw new Error(`staging effect ${effectId} is malformed`);
    }
    return value as unknown as StageEffect & { before: ActivePointer; after: ActivePointer };
  };

  const writeEffect = async (effect: StageEffect): Promise<void> => {
    await writeAtomic(effectPath(effect.effectId), `${JSON.stringify(effect, null, 2)}\n`);
  };

  const ensureBlob = async (hash: string, bytes: Uint8Array): Promise<void> => {
    if (!isHash(hash) || createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw new Error("staging blob bytes do not match the requested content hash");
    }
    const path = resolve(artifactDirectory, hash);
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (createHash("sha256").update(existing).digest("hex") !== hash) {
        throw new Error(`immutable staging blob ${hash} failed integrity verification`);
      }
    }
  };

  const verifyBlob = async (hash: string | null): Promise<boolean> => {
    if (hash === null) return true;
    if (!isHash(hash)) return false;
    try {
      const bytes = await readFile(resolve(artifactDirectory, hash));
      return createHash("sha256").update(bytes).digest("hex") === hash;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  };

  const inspectNow = async (): Promise<StageInspection> => {
    const pointer = await readPointer();
    const activePresent = await verifyBlob(pointer.activeHash);
    const previousPresent = await verifyBlob(pointer.rollbackTarget?.activeHash ?? null);
    const issue = !activePresent
      ? `active staging blob ${pointer.activeHash ?? ""} is missing or corrupt`
      : !previousPresent
        ? `rollback staging blob ${pointer.rollbackTarget?.activeHash ?? ""} is missing or corrupt`
        : undefined;
    return {
      activeHash: pointer.activeHash,
      previousHash: pointer.rollbackTarget?.activeHash ?? null,
      activatedAt: pointer.activatedAt,
      effectId: pointer.effectId,
      intact: issue === undefined,
      ...(issue ? { issue } : {}),
    };
  };

  const completePending = async (effect: StageEffect): Promise<StageEffect> => {
    const completed: StageEffect = { ...effect, status: "completed" };
    await writeEffect(completed);
    return completed;
  };

  const replayOrApply = async (effect: StageEffect): Promise<StageEffect> => {
    const pointer = await readPointer();
    if (samePointer(pointer, effect.after)) {
      return effect.status === "completed" ? effect : completePending(effect);
    }
    if (!samePointer(pointer, effect.before)) {
      throw new Error(`active staging pointer changed during effect ${effect.effectId}`);
    }
    const targetIntact = await verifyBlob(effect.after.activeHash);
    const rollbackIntact = await verifyBlob(effect.after.rollbackTarget?.activeHash ?? null);
    if (!targetIntact || !rollbackIntact)
      throw new Error(`staging effect ${effect.effectId} cannot restore a verified artifact`);
    await writePointer(effect.after);
    return completePending(effect);
  };

  const initialize = (): Promise<void> =>
    serial(async () => {
      await mkdir(artifactDirectory, { recursive: true });
      await mkdir(effectDirectory, { recursive: true });
      try {
        await readPointer();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "active staging pointer has not been initialized")
          throw error;
        const baseline: ActivePointer = {
          version: 1,
          activeHash: null,
          activatedAt: clock(),
          effectId: BASELINE_EFFECT_ID,
          rollbackTarget: null,
        };
        await writePointer(baseline);
      }
      const inspection = await inspectNow();
      if (!inspection.intact) throw new Error(inspection.issue ?? "staging target failed integrity verification");
    });

  const snapshot = async (): Promise<StagedArtifact> => {
    const source = await options.snapshotSource();
    const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
    return {
      hash: createHash("sha256").update(bytes).digest("hex"),
      dataBase64: bytes.toString("base64"),
    };
  };

  const inspect = (): Promise<StageInspection> => serial(inspectNow);

  const verifyRollbackPath = (): Promise<StageRollbackPathVerification> =>
    serial(async () => {
      const pointer = await readPointer();
      const activeIntact = await verifyBlob(pointer.activeHash);
      const rollbackHash = pointer.rollbackTarget?.activeHash ?? null;
      const rollbackIntact = await verifyBlob(rollbackHash);
      if (!activeIntact || !rollbackIntact) {
        return {
          restorable: false,
          activeHash: pointer.activeHash,
          rollbackHash,
          evidence: `stage:rollback-path:missing-blob:${pointer.activeHash ?? "baseline"}:${rollbackHash ?? "baseline"}`,
        };
      }

      await writePointer(pointer);
      const restored = await readPointer();
      const pointerIntact = samePointer(pointer, restored);
      return {
        restorable: pointerIntact,
        activeHash: pointer.activeHash,
        rollbackHash,
        evidence: `stage:rollback-path:${pointerIntact ? "verified" : "mismatch"}:${pointer.effectId}`,
      };
    });

  const ship = (input: { effectId: string; artifact: StagedArtifact }): Promise<StageShipResult> =>
    serial(async () => {
      const bytes = toBytes(input.artifact);
      const prior = await readEffect(input.effectId);
      if (prior) {
        if (prior.operation !== "ship" || prior.artifactHash !== input.artifact.hash) {
          throw new Error(`staging effect ${input.effectId} was reused with different intent`);
        }
        if (prior.status === "completed") return prior.result as StageShipResult;
        const resolved = await replayOrApply(prior);
        return resolved.result as StageShipResult;
      }

      const inspection = await inspectNow();
      if (!inspection.intact) throw new Error(inspection.issue ?? "staging target failed integrity verification");
      const before = await readPointer();
      await ensureBlob(input.artifact.hash, bytes);
      const after: ActivePointer = {
        version: 1,
        activeHash: input.artifact.hash,
        activatedAt: clock(),
        effectId: input.effectId,
        rollbackTarget: before,
      };
      const result: StageShipResult = {
        effectId: input.effectId,
        artifactHash: input.artifact.hash,
        previousHash: before.activeHash,
      };
      const pending: StageEffect = {
        version: 1,
        effectId: input.effectId,
        operation: "ship",
        status: "pending",
        before,
        after,
        artifactHash: input.artifact.hash,
        result,
      };
      await writeEffect(pending);
      const completed = await replayOrApply(pending);
      return completed.result as StageShipResult;
    });

  const rollback = (input: { effectId: string; expectedActiveHash: string }): Promise<StageRollbackResult> =>
    serial(async () => {
      const prior = await readEffect(input.effectId);
      if (prior) {
        if (prior.operation !== "rollback" || prior.expectedActiveHash !== input.expectedActiveHash) {
          throw new Error(`staging effect ${input.effectId} was reused with different intent`);
        }
        if (prior.status === "completed") return prior.result as StageRollbackResult;
        const resolved = await replayOrApply(prior);
        return resolved.result as StageRollbackResult;
      }

      const pointer = await readPointer();
      if (pointer.activeHash !== input.expectedActiveHash) {
        throw new Error(
          `active staging artifact changed: expected ${input.expectedActiveHash}, found ${pointer.activeHash}`,
        );
      }
      if (!pointer.activeHash) throw new Error("there is no active staging artifact to roll back");
      const inspection = await inspectNow();
      if (!inspection.intact) throw new Error(inspection.issue ?? "staging target failed integrity verification");
      const target = pointer.rollbackTarget ?? {
        version: 1 as const,
        activeHash: null,
        activatedAt: clock(),
        effectId: BASELINE_EFFECT_ID,
        rollbackTarget: null,
      };
      const result: StageRollbackResult = { effectId: input.effectId, restoredHash: target.activeHash };
      const pending: StageEffect = {
        version: 1,
        effectId: input.effectId,
        operation: "rollback",
        status: "pending",
        before: pointer,
        after: target,
        expectedActiveHash: input.expectedActiveHash,
        result,
      };
      await writeEffect(pending);
      const completed = await replayOrApply(pending);
      return completed.result as StageRollbackResult;
    });

  return { initialize, snapshot, inspect, verifyRollbackPath, ship, rollback };
};
