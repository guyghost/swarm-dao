import { describe, expect, it } from "bun:test";
import { exec as execCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { main } from "../src/cli.js";

describe("cli.ts", () => {
  it("returns 0 for help command", async () => {
    const code = await main(["help"], process.cwd());
    expect(code).toBe(0);
  });

  it("fails fast when herdr child-session commands are misused", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "swarm-cli-herdr-"));
    try {
      // Missing arguments surface usage before any herdr effect.
      expect(await main(["deliberate"], tmp)).toBe(1);
      expect(await main(["implement"], tmp)).toBe(1);
      // Invalid herdr kind fails fast — before DAO init or workspace create.
      expect(await main(["deliberate", "1", "--kind", "Codex; rm-rf"], tmp)).toBe(1);
      expect(await main(["roundtable", "--kind"], tmp)).toBe(1);
      expect(await main(["implement", "1", "--timeout-ms"], tmp)).toBe(1);
      expect(await main(["implement", "1", "--timeout-ms", "abc"], tmp)).toBe(1);
      // Host selection: invalid values fail fast; tmux requires tmux.command;
      // --kind is herdr-only.
      expect(await main(["deliberate", "1", "--host", "zsh"], tmp)).toBe(1);
      expect(await main(["deliberate", "1", "--host"], tmp)).toBe(1);
      expect(await main(["roundtable", "--host", "tmux"], tmp)).toBe(1);
      expect(await main(["roundtable", "--host", "tmux", "--kind", "pi"], tmp)).toBe(1);
      // Unknown proposal: DAO initializes fine, but no child sessions spawn.
      await main(["init"], tmp);
      await main(["setup"], tmp);
      expect(await main(["deliberate", "99"], tmp)).toBe(1);
      expect(await main(["implement", "99"], tmp)).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("refuses parallel implement without execution isolation", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "swarm-cli-impl-"));
    try {
      await main(["init"], tmp);
      await main(["setup"], tmp);
      await main(["propose", "--title", "a", "--type", "feature", "--description", "d"], tmp);
      await main(["propose", "--title", "b", "--type", "feature", "--description", "d"], tmp);
      // Two ids without execution.isolation would share one checkout.
      expect(await main(["implement", "1", "2"], tmp)).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli.ts — improve sandbox flags", () => {
  it("fails fast when a sandbox flag is passed without a value", async () => {
    const code = await main(["improve", "once", "--series-id", "t", "--sandbox"], process.cwd());
    expect(code).toBe(1);
  });

  it("fails fast on an unknown sandbox mode", async () => {
    const code = await main(["improve", "once", "--series-id", "t", "--sandbox", "vagrant"], process.cwd());
    expect(code).toBe(1);
  });

  it("fails fast when --cpus carries no numeric value", async () => {
    const code = await main(["improve", "once", "--series-id", "t", "--cpus"], process.cwd());
    expect(code).toBe(1);
  });
});

describe("cli.ts — improve series roots", () => {
  it("fails status for an unknown series with the resolved root (no phantom idle answer, issue #144)", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "swarm-cli-status-"));
    const code = await main(["improve", "status", "--series-id", "nope", "--evidence-root", tmp], process.cwd());
    expect(code).toBe(1);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fails fast on a value-less --cycle-root or --evidence-root flag", async () => {
    expect(await main(["improve", "once", "--series-id", "t", "--cycle-root"], process.cwd())).toBe(1);
    expect(await main(["improve", "once", "--series-id", "t", "--evidence-root"], process.cwd())).toBe(1);
  });

  it("fails fast on an unknown --exec mode or an invalid --agent kind", async () => {
    expect(await main(["improve", "once", "--series-id", "t", "--exec", "vm"], process.cwd())).toBe(1);
    expect(await main(["improve", "once", "--series-id", "t", "--exec"], process.cwd())).toBe(1);
    expect(await main(["improve", "once", "--series-id", "t", "--agent"], process.cwd())).toBe(1);
    expect(await main(["improve", "once", "--series-id", "t", "--agent", "Codex; rm-rf"], process.cwd())).toBe(1);
    expect(await main(["improve", "once", "--series-id", "t", "--agent-args"], process.cwd())).toBe(1);
  });

  it("once --exec worktree prepares a dao/loop worktree in a git repo", async () => {
    const exec = promisify(execCallback);
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "swarm-improve-wt-"));
    try {
      await exec("git init -q .", { cwd });
      await exec("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd });
      await fs.mkdir(path.join(cwd, ".dao"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".dao/improvement.json"),
        JSON.stringify({
          anchorCommands: {
            "drift-audit": "echo drift",
            "anchor-reality": "echo reality",
            "frozen-set-intact": "echo frozen",
            regression: "echo regression",
          },
        }),
        "utf8",
      );
      // The series must exist before once (phantom-series guard, issue #144):
      // init refuses an existing journal without --force, which this fresh
      // series does not have.
      expect(
        await main(["improve", "init", "--series-id", "wt-1", "--scope", "s", "--reference-hash", "a".repeat(64)], cwd),
      ).toBe(0);
      const code = await main(["improve", "once", "--series-id", "wt-1", "--exec", "worktree"], cwd);
      expect(code).toBe(0);
      const marker = await fs.readFile(path.join(cwd, ".dao/worktrees/wt-1/.git"), "utf8");
      expect(marker).toContain("gitdir:");
      // No second once here: with the cycle initialized it would drive real
      // sampling workers instead of just proving worktree reuse.
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("init refuses an existing journal unless --force (replay is not a clean slate, issue #144)", async () => {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "swarm-improve-init-"));
    try {
      await fs.mkdir(path.join(cwd, ".dao"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".dao/improvement.json"),
        JSON.stringify({
          anchorCommands: {
            "drift-audit": "echo drift",
            "anchor-reality": "echo reality",
            "frozen-set-intact": "echo frozen",
            regression: "echo regression",
          },
        }),
        "utf8",
      );
      const base = ["improve", "init", "--series-id", "s1", "--scope", "s", "--reference-hash", "a".repeat(64)];
      expect(await main(base, cwd)).toBe(0);
      // Second init without --force must refuse (the journal exists).
      expect(await main(base, cwd)).toBe(1);
      // --force acknowledges the replay: the runner restores the already-
      // started series and the MACHINE rejects a second START_SERIES (exit 2
      // = rejected submission; state unchanged). Resume is once/submit.
      expect(await main([...base, "--force"], cwd)).toBe(2);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli.ts — graph runs", () => {
  const tmpCwd = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "swarm-graph-cli-"));
    return dir;
  };

  it("init creates the run and status answers for it", async () => {
    const cwd = await tmpCwd();
    try {
      expect(await main(["graph", "init", "--run-id", "cli-test"], cwd)).toBe(0);
      expect(await main(["graph", "status", "--run-id", "cli-test"], cwd)).toBe(0);
      const active = JSON.parse(await fs.readFile(path.join(cwd, ".dao/graph-runs/active-run.json"), "utf8"));
      expect(active).toEqual({ runId: "cli-test" });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails fast on a missing subcommand, --run-id, or signal", async () => {
    const cwd = await tmpCwd();
    try {
      expect(await main(["graph"], cwd)).toBe(1);
      expect(await main(["graph", "init"], cwd)).toBe(1);
      expect(await main(["graph", "submit", "--run-id", "x"], cwd)).toBe(1);
      expect(await main(["graph", "init", "--run-id", "x", "--evidence-root"], cwd)).toBe(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns 2 when the machine rejects a signal", async () => {
    const cwd = await tmpCwd();
    try {
      await main(["graph", "init", "--run-id", "cli-test"], cwd);
      const signalPath = path.join(cwd, "signal.json");
      await fs.writeFile(
        signalPath,
        JSON.stringify({
          runId: "cli-test",
          type: "MODEL_APPROVED",
          source: "human",
          producer: "human-owner",
          occurredAt: new Date().toISOString(),
          payload: { modelHash: "unreviewed" },
          evidence: [],
        }),
        "utf8",
      );
      // No model was drafted: the machine must refuse the approval.
      expect(await main(["graph", "submit", "--run-id", "cli-test", "--signal", "signal.json"], cwd)).toBe(2);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli.ts — product runs", () => {
  const tmpCwd = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "swarm-product-cli-"));
    return dir;
  };

  it("init creates the run under .dao/product-loops and status answers for it", async () => {
    const cwd = await tmpCwd();
    try {
      expect(await main(["product", "init", "--run-id", "cli-test"], cwd)).toBe(0);
      expect(await main(["product", "status", "--run-id", "cli-test"], cwd)).toBe(0);
      expect(fs.stat(path.join(cwd, ".dao/product-loops/cli-test/snapshot.json"))).resolves.toBeDefined();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails fast on a missing subcommand, --run-id, or value-less flags", async () => {
    const cwd = await tmpCwd();
    try {
      expect(await main(["product"], cwd)).toBe(1);
      expect(await main(["product", "status"], cwd)).toBe(1);
      expect(await main(["product", "init", "--run-id", "x", "--evidence-root"], cwd)).toBe(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
