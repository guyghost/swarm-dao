/** Technical time source injected by the imperative shell. */
export interface ClockPort {
  now(): string;
}

/** Default shell implementation. Domain and model code must not import it. */
export const systemClock: ClockPort = {
  now: () => new Date().toISOString(),
};
