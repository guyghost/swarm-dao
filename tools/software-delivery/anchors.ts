import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createLocalStagingTarget } from "../../packages/software-delivery/src/staging-target.js";
import { APPROVED_DELIVERY_MODEL_HASH, validateDeliveryContract } from "./contract.js";

export type DeliveryAnchorCommand = Readonly<{ anchor: string; command: string }>;
export type DeliveryAnchorResult = Readonly<{
  anchor: string;
  command: string;
  passed: boolean;
  execution: "spawned" | "local-staging-check";
  exitCode: number | null;
}>;

const COMMAND_PATTERN = /^[A-Za-z0-9_./:-]+(?: [A-Za-z0-9_./:-]+)*$/;
const SELF_STAGING_COMMAND = "bun run software-delivery:anchors";

const parseCommand = (command: string): readonly [string, ...string[]] => {
  if (!COMMAND_PATTERN.test(command)) throw new Error(`anchor command contains shell syntax: ${command}`);
  const [executable, ...args] = command.split(" ");
  if (!executable) throw new Error("anchor command has no executable");
  return [executable, ...args];
};

export const readDeliveryAnchorCommands = async (
  root: string,
): Promise<{
  modelHash: string;
  commands: readonly DeliveryAnchorCommand[];
}> => {
  const contract = await validateDeliveryContract(root);
  if (!contract.valid || contract.modelHash !== APPROVED_DELIVERY_MODEL_HASH) {
    throw new Error(`approved delivery contract is invalid: ${contract.issues.join("; ")}`);
  }
  const graph = JSON.parse(await Bun.file(resolve(root, "models/software-delivery.graph.json")).text()) as {
    requiredAnchors?: unknown;
    anchorCommands?: unknown;
  };
  if (!Array.isArray(graph.requiredAnchors) || !graph.requiredAnchors.every((anchor) => typeof anchor === "string")) {
    throw new Error("delivery graph has no valid required anchor list");
  }
  if (
    typeof graph.anchorCommands !== "object" ||
    graph.anchorCommands === null ||
    Array.isArray(graph.anchorCommands)
  ) {
    throw new Error("delivery graph has no valid anchor command table");
  }
  const table = graph.anchorCommands as Record<string, unknown>;
  return {
    modelHash: contract.modelHash,
    commands: graph.requiredAnchors.map((anchor) => {
      const command = table[anchor];
      if (typeof command !== "string" || !COMMAND_PATTERN.test(command)) {
        throw new Error(`delivery graph anchor ${anchor} has no safe command`);
      }
      return { anchor, command };
    }),
  };
};

const runSpawnedCommand = (command: string, cwd: string): Promise<number | null> => {
  const [executable, ...args] = parseCommand(command);
  return new Promise((resolveExit) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: "inherit" });
    child.once("error", () => resolveExit(null));
    child.once("close", (code) => resolveExit(code));
  });
};

const verifyLocalStaging = async (): Promise<boolean> => {
  const root = await mkdtemp(resolve(tmpdir(), "swarm-delivery-anchor-"));
  try {
    const target = createLocalStagingTarget({
      stageRoot: resolve(root, "evidence/software-delivery-stage"),
      snapshotSource: async () => "rollback anchor check",
    });
    await target.initialize();
    const proof = await target.verifyRollbackPath();
    return proof.restorable;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const runDeliveryAnchors = async (
  root: string,
  requestedAnchors?: readonly string[],
): Promise<{ modelHash: string; results: readonly DeliveryAnchorResult[] }> => {
  const { modelHash, commands } = await readDeliveryAnchorCommands(root);
  const selected = requestedAnchors?.length
    ? commands.filter(({ anchor }) => requestedAnchors.includes(anchor))
    : commands;
  const unknown = (requestedAnchors ?? []).filter((anchor) => !commands.some((entry) => entry.anchor === anchor));
  if (unknown.length > 0) throw new Error(`unknown software-delivery anchor(s): ${unknown.join(", ")}`);

  const results: DeliveryAnchorResult[] = [];
  for (const { anchor, command } of selected) {
    if (anchor === "rollback-path-exists" && command === SELF_STAGING_COMMAND) {
      const passed = await verifyLocalStaging();
      results.push({ anchor, command, passed, execution: "local-staging-check", exitCode: passed ? 0 : 1 });
      continue;
    }
    const exitCode = await runSpawnedCommand(command, root);
    results.push({ anchor, command, passed: exitCode === 0, execution: "spawned", exitCode });
  }
  return { modelHash, results };
};

const requestedAnchorFromArgs = (args: readonly string[]): string[] => {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--anchor") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--anchor requires an anchor ID");
      selected.push(value);
      index += 1;
    } else if (arg.startsWith("--anchor=")) {
      selected.push(arg.slice("--anchor=".length));
    } else {
      throw new Error(`unknown software-delivery anchor option: ${arg}`);
    }
  }
  return selected;
};

const main = async (): Promise<void> => {
  const result = await runDeliveryAnchors(process.cwd(), requestedAnchorFromArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.results.some((anchor) => !anchor.passed)) process.exitCode = 1;
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
