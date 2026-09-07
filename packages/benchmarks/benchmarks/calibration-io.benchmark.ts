import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BenchmarkSuite } from "../src/harness.js";

const PAYLOAD = Buffer.alloc(2048, 0x5a);

let ioDir: string;

/**
 * Fixed filesystem kernel, deliberately independent of repository code: it
 * measures how fast THIS runner's disk is TODAY (mkdir + small write — the
 * same syscalls the persistence suite pays). The comparison script scales the
 * gate for I/O-bound suites by this ratio, because the pure-CPU kernel cannot
 * see runner-to-runner disk variance (the PR #133 incident: persistence cases
 * flagged at +60–106% with a calibration-identical CPU).
 */
export const calibrationIoSuite: BenchmarkSuite = {
  name: "calibration-io",
  iterations: 25,
  setup: async () => {
    ioDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-bench-io-"));
  },
  teardown: async () => {
    await fs.rm(ioDir, { recursive: true, force: true });
  },
  cases: [
    {
      name: "io kernel",
      run: async () => {
        const target = path.join(ioDir, "kernel.bin");
        await fs.writeFile(target, PAYLOAD);
        await fs.rm(target, { force: true });
      },
    },
  ],
};
