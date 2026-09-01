import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";

describe("cli.ts", () => {
  it("returns 0 for help command", async () => {
    const code = await main(["help"], process.cwd());
    expect(code).toBe(0);
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
  it("answers status for an unknown series (fresh idle runner; no DAO proposal state touched)", async () => {
    const code = await main(["improve", "status", "--series-id", "nope"], process.cwd());
    expect(code).toBe(0);
  });

  it("fails fast on a value-less --cycle-root or --evidence-root flag", async () => {
    expect(await main(["improve", "once", "--series-id", "t", "--cycle-root"], process.cwd())).toBe(1);
    expect(await main(["improve", "once", "--series-id", "t", "--evidence-root"], process.cwd())).toBe(1);
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
