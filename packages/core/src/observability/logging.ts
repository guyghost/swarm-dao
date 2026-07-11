// ============================================================
// Swarm DAO Core — Logging Utility
// ============================================================

export type LogLevel = "info" | "warn" | "error" | "debug";

export type LogHandler = (level: LogLevel, message: string, ...args: unknown[]) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLogLevel: LogLevel = "debug";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLogLevel];
}

function defaultLogHandler(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!shouldLog(level)) return;
  switch (level) {
    case "info":
      console.log(message, ...args);
      break;
    case "warn":
      console.warn(message, ...args);
      break;
    case "error":
      console.error(message, ...args);
      break;
    case "debug":
      console.debug(message, ...args);
      break;
  }
}

let currentHandler: LogHandler = defaultLogHandler;

/** Set the minimum log level emitted by the default handler. */
export function setMinLogLevel(level: LogLevel): void {
  minLogLevel = level;
}

/** Reset the minimum log level to debug (most verbose). */
export function resetMinLogLevel(): void {
  minLogLevel = "debug";
}

/**
 * Configure the global log handler.
 * Set to null to disable logging.
 */
export function setLogHandler(handler: LogHandler | null): void {
  if (handler === null) {
    currentHandler = () => {};
  } else {
    currentHandler = handler;
  }
}

/** Restore the built-in console log handler. */
export function resetLogHandler(): void {
  currentHandler = defaultLogHandler;
}

function emitLog(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!shouldLog(level)) return;
  currentHandler(level, message, ...args);
}

export const logger = {
  info: (message: string, ...args: unknown[]) => emitLog("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => emitLog("warn", message, ...args),
  error: (message: string, ...args: unknown[]) => emitLog("error", message, ...args),
  debug: (message: string, ...args: unknown[]) => emitLog("debug", message, ...args),
};
