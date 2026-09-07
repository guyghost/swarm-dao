import { describe, expect, it } from "bun:test";
import { childSessionName, detectHostSession, sanitizeTmuxName } from "../src/environment.js";

describe("parent-session detection", () => {
  it("detects herdr via HERDR_ENV=1", () => {
    expect(detectHostSession({ HERDR_ENV: "1", TMUX: "/tmp/tmux-0/default" } as NodeJS.ProcessEnv)).toBe("herdr");
  });

  it("detects tmux via the TMUX socket variable", () => {
    expect(detectHostSession({ TMUX: "/tmp/tmux-0/default,123,0" } as NodeJS.ProcessEnv)).toBe("tmux");
  });

  it("reports none on a bare shell (empty TMUX included)", () => {
    expect(detectHostSession({} as NodeJS.ProcessEnv)).toBe("none");
    expect(detectHostSession({ TMUX: "" } as NodeJS.ProcessEnv)).toBe("none");
  });
});

describe("child session naming per host", () => {
  const herdrName = (_prefix: string, proposalId: number, agentId: string) => `p${proposalId}-${agentId}-hash`;

  it("herdr children carry the adapter's hashed names", () => {
    expect(childSessionName("herdr", herdrName, "swarm-dao", 1, "critic")).toBe("p1-critic-hash");
  });

  it("tmux children use the plain sanitized session names the adapter creates", () => {
    expect(childSessionName("tmux", herdrName, "swarm-dao", 1, "critic")).toBe("swarm-dao-p1-critic");
    expect(childSessionName("tmux", herdrName, "swarm-dao", 12, "../Weird/ID 99")).toBe("swarm-dao-p12-Weird-ID-99");
  });

  it("sanitizeTmuxName mirrors the tmux adapter charset ([a-zA-Z0-9_-])", () => {
    expect(sanitizeTmuxName("critic/risk agent")).toBe("critic-risk-agent");
    expect(sanitizeTmuxName("---x---")).toBe("x");
    expect(sanitizeTmuxName("///")).toBe("agent");
  });
});
