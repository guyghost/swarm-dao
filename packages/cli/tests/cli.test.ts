import { describe, expect, it } from "bun:test";
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
