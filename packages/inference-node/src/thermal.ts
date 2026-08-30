/**
 * Thermal state on a desktop.
 *
 * The contract requires `getThermalState()` because it is load-bearing on a
 * phone: it drives the rail readout and the device-pressure check that falls
 * back to a remote provider before the OS starts throttling.
 *
 * There is no cross-platform Node equivalent. macOS has `powermetrics`
 * (root-only), Linux exposes `/sys/class/thermal` inconsistently across
 * hardware, and Windows needs WMI. None is reliable enough to make a fallback
 * decision on, and a wrong reading here is worse than none — it would move a
 * turn off-device for no reason.
 *
 * So this reports `nominal` and says it is doing so, exactly as the web shim
 * does. `checkDevicePressure` in the app already tolerates a constant; what it
 * must not get is a plausible-looking number that is actually a guess.
 *
 * If a per-OS sensor is added later, it belongs behind this function, and the
 * `simulated` flag on capabilities is how the UI learns to stop trusting it.
 */
import type { ThermalState } from '@chatterang/contracts';

export function readThermalState(): ThermalState {
  return { level: 0, state: 'nominal', throttled: false };
}
