// ============================================================
// Swarm DAO Core — Logging Utility
// ============================================================

export type LogLevel = "info" | "warn" | "error" | "debug";

export type LogHandler = (level: LogLevel, message: string, ...args: unknown[]) => void;

let currentHandler: LogHandler = (level, message, ...args) => {
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
};

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

export const logger = {
  info: (message: string, ...args: unknown[]) => currentHandler("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => currentHandler("warn", message, ...args),
  error: (message: string, ...args: unknown[]) => currentHandler("error", message, ...args),
  debug: (message: string, ...args: unknown[]) => currentHandler("debug", message, ...args),
};
