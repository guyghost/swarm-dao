// MCP tool argument validation (issue #161): the CallTool handler must
// enforce the schemas it publishes in ListTools — before any handler runs.
import { describe, expect, it } from "bun:test";
import type { ToolJsonSchema } from "../src/tool-schemas.js";
import { createToolInputSchemas, validateToolArgs } from "../src/tool-schemas.js";

const schemas = createToolInputSchemas({
  proposalTypes: ["product-feature", "technical-change"],
  graphAiEvents: ["MODEL_DRAFTED", "IMPLEMENTATION_READY"],
  productAiEvents: ["AGENT_SIGNAL", "PROPOSAL_DRAFTED"],
  attentionSources: ["graph", "product"],
});

describe("mcp tool argument validation (issue #161)", () => {
  it("rejects a missing required argument", () => {
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, {})).toThrow(/'proposalId' is required/);
  });

  it("rejects a non-numeric / non-integer proposal id", () => {
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, { proposalId: "abc" })).toThrow(
      /proposalId must be a finite number/,
    );
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, { proposalId: Number("abc") })).toThrow(
      /must be a finite number/,
    );
  });

  it("rejects an out-of-range rating score", () => {
    expect(() => validateToolArgs("dao_rate", schemas.dao_rate, { proposalId: 1, score: 999, comment: "x" })).toThrow(
      /score must be <= 5/,
    );
    expect(() => validateToolArgs("dao_rate", schemas.dao_rate, { proposalId: 1, score: 0, comment: "x" })).toThrow(
      /score must be >= 1/,
    );
  });

  it("rejects malformed outputs arrays element by element", () => {
    const args = { proposalId: 1, outputs: [{ agentId: "a" }] };
    expect(() => validateToolArgs("dao_record_outputs", schemas.dao_record_outputs, args)).toThrow(
      /missing required property 'content'/,
    );
    expect(() =>
      validateToolArgs("dao_record_outputs", schemas.dao_record_outputs, { proposalId: 1, outputs: "all-good" }),
    ).toThrow(/outputs must be an array/);
  });

  it("rejects string arrays with non-string elements", () => {
    expect(() =>
      validateToolArgs("dao_propose", schemas.dao_propose, {
        title: "t",
        type: "product-feature",
        description: "d",
        acceptanceCriteria: [1, 2, 3],
      }),
    ).toThrow(/acceptanceCriteria\[0\] must be a string/);
  });

  it("rejects forged event types on AI channels", () => {
    const base = { runId: "r", producer: "p", payload: {}, evidence: ["e"] };
    expect(() =>
      validateToolArgs("dao_graph_submit", schemas.dao_graph_submit, { ...base, type: "MODEL_APPROVED" }),
    ).toThrow(/must be one of/);
    expect(() =>
      validateToolArgs("dao_product_submit", schemas.dao_product_submit, { ...base, type: "CANCEL" }),
    ).toThrow(/must be one of/);
  });

  it("rejects a non-integer proposal id (review)", () => {
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, { proposalId: 1.2 })).toThrow(
      /proposalId must be an integer/,
    );
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, { proposalId: Number.NaN })).toThrow(
      /must be a finite number/,
    );
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, { proposalId: 3 })).not.toThrow();
  });

  it("rejects malformed argument shapes with a precise message (review)", () => {
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, null)).toThrow(
      /arguments must be an object/,
    );
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, [1, 2])).toThrow(
      /arguments must be an object/,
    );
    expect(() => validateToolArgs("dao_deliberate", schemas.dao_deliberate, "proposalId")).toThrow(
      /arguments must be an object/,
    );
  });

  it("accepts legitimate arguments", () => {
    expect(() =>
      validateToolArgs("dao_graph_submit", schemas.dao_graph_submit, {
        runId: "r",
        type: "MODEL_DRAFTED",
        producer: "p",
        payload: { k: 1 },
        evidence: ["a"],
      }),
    ).not.toThrow();
    expect(() => validateToolArgs("dao_ship", schemas.dao_ship, { proposalId: 3, cascade: true })).not.toThrow();
  });

  it("ignores unknown tools and unknown arguments", () => {
    expect(() => validateToolArgs("dao_mystery", undefined, { any: "thing" })).not.toThrow();
    expect(() => validateToolArgs("dao_ship", schemas.dao_ship, { proposalId: 1, extra: true })).not.toThrow();
  });

  it("the published schemas are plain JSON-schema-compatible objects", () => {
    // ListTools publishes these directly: they must not carry functions or
    // host-side state.
    for (const schema of Object.values(schemas)) {
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    }
  });

  it("required objects validate nested structure", () => {
    const nested: ToolJsonSchema = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "object", required: ["b"], properties: { b: { type: "string" } } } },
    };
    expect(() => validateToolArgs("t", nested, {})).toThrow(/'a' is required/);
    expect(() => validateToolArgs("t", nested, { a: {} })).toThrow(/missing required property 'b'/);
    expect(() => validateToolArgs("t", nested, { a: { b: "ok" } })).not.toThrow();
  });
});
