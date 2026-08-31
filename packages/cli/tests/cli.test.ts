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
  it("status on an unknown series in an empty project still answers (fresh idle runner)", async () => {
    const code = await main(["improve", "status", "--series-id", "nope"], process.cwd());
    expect(code).toBe(0);
  });
});

describe("cli.ts — improve series roots", () => {
  it("answers status for an unknown series without touching DAO proposal state", async () => {
    const code = await main(["improve", "status", "--series-id", "nope"], process.cwd());
    expect(code).toBe(0);
  });
});
