import { createHash } from "node:crypto";
import type { BenchmarkSuite } from "../src/harness.js";

const PAYLOAD = Buffer.alloc(1024, 0x5a);
const HASHES_PER_OP = 40;

/**
 * Fixed pure-CPU kernel, deliberately independent of repository code: its only
 * job is to measure how fast the current runner is TODAY. The comparison script
 * uses it to scale its regression thresholds when a shared runner runs slow —
 * code changes never touch this file, so calibration drift is pure runner noise.
 */
export const calibrationSuite: BenchmarkSuite = {
  name: "calibration",
  iterations: 25,
  cases: [
    {
      name: "reference kernel",
      run: () => {
        for (let index = 0; index < HASHES_PER_OP; index++) {
          createHash("sha256").update(PAYLOAD).digest();
        }
      },
    },
  ],
};
