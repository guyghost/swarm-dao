// Swarm DAO CLI — `watch`: a live pane over attention and workflows.
//
// One screen, refreshed on an interval: pending human gates with runnable
// commands, cooldown countdowns, in-flight runs. Ctrl-C exits cleanly.
// `--once` renders a single frame (no TTY needed) for scripts and tests.

import { renderNext } from "./next.js";
import { c } from "./render.js";

const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
const DEFAULT_INTERVAL_SECONDS = 3;

export async function cmdWatch(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const once = flags.once === true;

  let intervalMs = DEFAULT_INTERVAL_SECONDS * 1000;
  if (flags.interval !== undefined) {
    if (typeof flags.interval !== "string" || flags.interval.trim().length === 0) {
      process.stderr.write("error: --interval requires a value (seconds)\n");
      return 1;
    }
    const seconds = Number(flags.interval);
    if (!Number.isFinite(seconds) || seconds < 1) {
      process.stderr.write("error: --interval must be a number of seconds >= 1\n");
      return 1;
    }
    intervalMs = seconds * 1000;
  }

  if (once) {
    process.stdout.write(await frame(cwd));
    return 0;
  }

  if (process.stdout.isTTY !== true) {
    process.stderr.write(
      "error: watch needs a TTY for the live pane — use `swarm-dao next`, or `watch --once` for a single frame\n",
    );
    return 1;
  }

  process.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(0);
  });

  for (;;) {
    process.stdout.write(CLEAR);
    process.stdout.write(await frame(cwd));
    await sleep(intervalMs);
  }
}

async function frame(cwd: string): Promise<string> {
  const body = await renderNext(cwd);
  const stamp = new Date().toISOString().slice(11, 19);
  return `${c.bold("swarm-dao watch")} ${c.dim(`— ${stamp} · Ctrl-C to exit`)}\n\n${body}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
