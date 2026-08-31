/**
 * ONE PROCESS PER ENGINE, and the object that owns the multiplicity.
 *
 * `Supervisor` is already generic over hosts — it takes a spawn FACTORY, an
 * engine list and a per-instance policy, and every singular field in it
 * (`#handle`, `#generation`, `#calls`, the ping trio, `#restarts`, `#closed`,
 * `#boot`) is correct PER INSTANCE. So two engines in two processes needs no
 * change to that class at all: it needs two instances of it. This file is the
 * two instances.
 *
 * WHY THE PROCESSES ARE SPLIT. `InferenceSession.run` is a synchronous native
 * call. It blocks the event loop of its process for its whole duration, and
 * the supervisor's liveness ping is answered on that loop — so a long enough
 * ONNX run is indistinguishable from a wedged host. Measured with the real
 * models: one whisper-base encoder run at batch 32 blocked 5506 ms and
 * llama.cpp emitted 0 tokens inside it; at the supervisor level, with the
 * shipped `DEFAULT_POLICY`, an unbroken block of 11-25 s is CONDEMNED, and
 * condemning a host kills it — which destroyed a real llama.cpp generation
 * with a synthesised terminal event and `HANDLE_LOST`. Two processes is what
 * stops one engine's blocking call from being the other engine's crash.
 *
 * WHY THIS IS A CLASS AND NOT FIFTEEN LINES IN `main.ts`. Two of the three
 * wiring mistakes the split makes possible fail LOUDLY at boot: registering a
 * plugin against a supervisor that does not serve it throws from
 * `Supervisor.plugin()`, and so does naming two engines with one plugin name.
 * The third does not. A renderer teardown that reaches only one supervisor
 * silently leaks exactly the other engine's turns and sessions for every
 * window that ever closes — no error, no log, nothing a boot check can see.
 * That asymmetry is the thing to design against, so the fan-outs live here,
 * where `tests/desktop-bridge.test.ts` can drive them, rather than as two
 * calls in the one file no test can import.
 */

import type { PluginImplementation } from './plugin-host.js';
import type { DshStatus, HostHandle } from './protocol.js';
import { Supervisor } from './supervisor.js';
import type {
  EngineSpec,
  NotifyListeners,
  SupervisorPolicy,
  SupervisorTimers,
} from './supervisor.js';

/** One engine, in its own process, under its own supervisor. */
export interface FleetEntry {
  readonly engine: EngineSpec;
  /**
   * The host process that serves it — passed to `spawn` and, in `main.ts`,
   * straight through to the forked entry point as `argv[3]`.
   *
   * A string rather than an enum because this file must not know what engines
   * exist; `host/host-engine.ts` owns that list, and it is on the far side of
   * a process boundary this directory may not import across.
   */
  readonly host: string;
  /**
   * Liveness and deadline policy for THIS host.
   *
   * The second half of the fix, and the half the split makes safe. A ping
   * budget sized to the worst legitimate single blocking call is dangerous
   * while one process holds both engines — it means a genuinely wedged host
   * takes that much longer to be replaced, and text generation is stuck behind
   * it the whole time. Once the ONNX host holds only ONNX, relaxing its
   * liveness costs nothing that llama.cpp depends on.
   */
  readonly policy?: Partial<SupervisorPolicy>;
}

export interface HostFleetOptions {
  /** Start one host process for the named engine. Called again on every loss. */
  readonly spawn: (host: string) => HostHandle;
  /** Emit one plugin event to every subscribed renderer. */
  readonly notify: NotifyListeners;
  readonly entries: readonly FleetEntry[];
  /** A host's DSH boot report, each time one arrives, tagged with the host. */
  readonly onBoot?: (host: string, status: DshStatus) => void;
  /** Where anomalies go, tagged with the host they came from. */
  readonly warn?: (host: string, message: string) => void;
  readonly timers?: SupervisorTimers;
}

export class HostFleet {
  /** Plugin name -> the supervisor that serves it. */
  readonly #byPlugin = new Map<string, Supervisor>();
  readonly #supervisors: Supervisor[] = [];

  constructor(options: HostFleetOptions) {
    if (options.entries.length === 0) {
      throw new Error('desktop bridge: a host fleet with no engines serves nothing.');
    }

    const hosts = new Set<string>();
    for (const entry of options.entries) {
      const pluginName = entry.engine.definition.name;
      if (this.#byPlugin.has(pluginName)) {
        throw new Error(
          `desktop bridge: two fleet entries serve plugin "${pluginName}". The plugin name is ` +
            'the wire address; a call naming it would have two processes to go to.',
        );
      }
      // Two engines forked with the same argument would be two processes both
      // serving the same plugin, each one answering half the calls at random.
      if (hosts.has(entry.host)) {
        throw new Error(
          `desktop bridge: two fleet entries name host "${entry.host}". Each engine gets its ` +
            'own process; sharing one is the coupling this fleet exists to remove.',
        );
      }
      hosts.add(entry.host);

      const supervisor = new Supervisor({
        spawn: () => options.spawn(entry.host),
        notify: options.notify,
        // ONE engine per supervisor. That is the whole of the isolation: a
        // supervisor's `#onClose` settles every turn of every engine it holds,
        // so an engine that shares a supervisor shares its condemnation.
        engines: [entry.engine],
        ...(options.onBoot === undefined
          ? {}
          : { onBoot: (status: DshStatus): void => options.onBoot?.(entry.host, status) }),
        ...(options.warn === undefined
          ? {}
          : { warn: (message: string): void => options.warn?.(entry.host, message) }),
        ...(entry.policy === undefined ? {} : { policy: entry.policy }),
        ...(options.timers === undefined ? {} : { timers: options.timers }),
      });

      this.#byPlugin.set(pluginName, supervisor);
      this.#supervisors.push(supervisor);
    }
  }

  /** The plugin names this fleet serves, in entry order. */
  get plugins(): readonly string[] {
    return [...this.#byPlugin.keys()];
  }

  /**
   * The supervisor serving one plugin.
   *
   * @throws Error for a plugin no entry named. Registering a manifest entry
   *   the fleet cannot serve would leave the renderer with channels whose
   *   every call fails at runtime, so this fails at boot instead.
   */
  supervisorFor(pluginName: string): Supervisor {
    const supervisor = this.#byPlugin.get(pluginName);
    if (supervisor === undefined) {
      throw new Error(
        `desktop bridge: this fleet serves no plugin named "${pluginName}". ` +
          `It serves: ${[...this.#byPlugin.keys()].join(', ')}.`,
      );
    }
    return supervisor;
  }

  /** The `PluginImplementation` for one plugin, from its own supervisor. */
  plugin(pluginName: string): PluginImplementation {
    return this.supervisorFor(pluginName).plugin(pluginName);
  }

  /** What `DshHost.getStatus()` answers for one plugin's host. */
  statusOf(pluginName: string): DshStatus {
    return this.supervisorFor(pluginName).hostStatus();
  }

  /**
   * A renderer is gone. Every host has to hear about it.
   *
   * THE FAN-OUT THAT FAILS SILENTLY IF IT IS WRONG. A window's turns and its
   * open sessions are spread across every host it ever called, and no boot
   * check, no type and no log can notice one being missed — the app keeps
   * working and leaks a Whisper pipeline per closed window. So it is one call
   * over the whole list, in a file a test can import, rather than one call per
   * supervisor at a site nothing can reach.
   */
  releaseRenderer(senderId: number, reason: string): void {
    for (const supervisor of this.#supervisors) supervisor.releaseRenderer(senderId, reason);
  }

  /** Stop supervising every host: no more ticks, no more restarts, all killed. */
  dispose(): void {
    for (const supervisor of this.#supervisors) supervisor.dispose();
  }

  /** Hosts spawned across the whole fleet. Exists so a test can assert it. */
  get spawnCount(): number {
    let total = 0;
    for (const supervisor of this.#supervisors) total += supervisor.spawnCount;
    return total;
  }
}
