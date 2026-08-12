import { afterEach, describe, expect, test } from "bun:test";
import { LocalWorkerProcessPort } from "../src/local-worker-process.js";

const workers: LocalWorkerProcessPort[] = [];

afterEach(async () => {
  for (const worker of workers) await worker.stopAll();
  workers.length = 0;
});

describe("LocalWorkerProcessPort", () => {
  test("launches a local child process and accepts only a structured worker result", async () => {
    const entrypoint = new URL("../src/main.ts", import.meta.url).pathname;
    const port = new LocalWorkerProcessPort([process.execPath, entrypoint]);
    workers.push(port);

    const started = await port.start("planner");
    const result = await port.send("planner", "Découpe la mission");

    expect(started.processId).toBeGreaterThan(0);
    expect(result.signal.kind).toBe("shared_message");
    expect(result.signal.messageId).toBe("planner:1");
    expect(result.signal.content).toContain("Découpe la mission");
    expect(result.activity.kind).toBe("worker_roundtrip");
    expect(await port.stop("planner")).toBe("stopped");
    expect(await port.stop("planner")).toBe("absent");
  });
});
