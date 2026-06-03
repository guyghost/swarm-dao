import { describe, expect, it } from "bun:test";
import { slugify } from "../src/integrations/utils.js";

describe("integrations/utils.ts", () => {
  it("slugifies title safely", () => {
    expect(slugify("Hello, Swarm DAO!")).toBe("hello-swarm-dao");
  });
});
