import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  logger,
  resetLogHandler,
  resetMinLogLevel,
  setLogHandler,
  setMinLogLevel,
} from "../src/observability/logging.js";

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

describe("observability/logging", () => {
  afterEach(() => {
    resetLogHandler();
    resetMinLogLevel();
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    mock.restore();
  });

  it("respects minimum log level with the default handler", () => {
    const logSpy = mock(() => {});
    const warnSpy = mock(() => {});
    const errorSpy = mock(() => {});
    const debugSpy = mock(() => {});

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    console.log = logSpy as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    console.warn = warnSpy as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    console.error = errorSpy as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    console.debug = debugSpy as any;

    resetLogHandler();
    setMinLogLevel("warn");

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("custom log handlers still receive filtered levels", () => {
    const handler = mock(() => {});
    setLogHandler(handler);
    setMinLogLevel("error");

    logger.info("hidden");
    logger.error("visible");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe("error");
  });
});
