export const CIRCUIT_OPEN_THRESHOLD = 5;
export const CIRCUIT_HALF_OPEN_AFTER_MS = 60_000;
export const QUARANTINE_DURATION_MS = 5 * 60_000;
export const HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;

export function getCircuitRecoveryAt(lastCheckAt: number | null): number | null {
  if (!lastCheckAt || lastCheckAt <= 0) {
    return null;
  }

  return lastCheckAt + CIRCUIT_HALF_OPEN_AFTER_MS;
}