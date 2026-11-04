// @effect-diagnostics nodeBuiltinImport:off - Path of the state directory, derived from the configured database path.
import * as NodePath from "node:path";

import {
  MAINTENANCE_LEASE_MS,
  LAST_RUNNING_VERSION_FILE,
  LastRunningVersion,
  type MaintenanceBlocker,
  type MaintenancePrepareMode,
  type MaintenanceRecoveryHold,
  type MaintenanceStatus,
} from "@starkfuture/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as AppBuild from "../appBuild.ts";
import * as ServerConfig from "../config.ts";
import { readMaintenanceBlockers } from "../orchestration-v2/ProjectionStore.ts";
import * as StateBackupRetention from "../persistence/StateBackupRetention.ts";
import * as StateFiles from "../persistence/StateFiles.ts";
import { forkParked } from "../serverActivation.ts";
import * as RecoveryHold from "./RecoveryHold.ts";

/**
 * Where new root work comes from. Each source is refused (or skipped, for
 * the ones that reload due work from durable state) while the gate is not
 * open; the automatic ones also wait while a recovery hold is in place.
 */
export type MaintenanceSource =
  | "command"
  | "scheduler"
  | "manual-run"
  | "webhook"
  | "storage-cleanup";

export class MaintenanceInProgressError extends Schema.TaggedError<MaintenanceInProgressError>()(
  "MaintenanceInProgressError",
  {
    source: Schema.Literals(["command", "scheduler", "manual-run", "webhook", "storage-cleanup"]),
    reason: Schema.Literals(["update", "recovery-hold"]),
  },
) {
  override get message(): string {
    return this.reason === "update"
      ? "Stark Code is updating; try again in a moment."
      : "Background work is paused after a restore until you resume it.";
  }
}

/**
 * One backend's update gate: `open -> closing -> closed -> open`.
 *
 * `prepare` closes it: new root work is refused at its sources while admitted
 * work drains. With nothing left running, effect claims pause (`closed`) and
 * the status reports `ready`. The desktop renews the 30 s lease every 10 s
 * until it stops this backend; an expired lease reopens the gate. There is no
 * way to stop a backend over its blockers.
 *
 * The default value is an always-open gate, for compositions without the
 * server's layer.
 */
export interface MaintenanceGateService {
  readonly status: Effect.Effect<MaintenanceStatus>;
  /**
   * Runs `effect` as admitted work from `source` and counts it as in flight
   * until it ends, or returns none without running it when `source` is refused.
   */
  readonly guard: <A, E, R>(
    source: MaintenanceSource,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /** Why `source` is refused now, if it is. */
  readonly refusal: (
    source: MaintenanceSource,
  ) => Effect.Effect<Option.Option<MaintenanceInProgressError>>;
  /** Whether `source` would be admitted now. */
  readonly admits: (source: MaintenanceSource) => Effect.Effect<boolean>;
  /** Whether any of these threads has work in flight; their follow-up work is admitted. */
  readonly hasActiveWork: (threadIds: ReadonlyArray<string>) => Effect.Effect<boolean>;
  /** True once the gate is closed: the effect worker claims nothing. */
  readonly claimsPaused: Effect.Effect<boolean>;
  /** True under a recovery hold: restart continuations wait for Resume. */
  readonly restartContinuationsHeld: Effect.Effect<boolean>;
  readonly prepare: (input: {
    readonly requestId: string;
    readonly mode: MaintenancePrepareMode;
  }) => Effect.Effect<MaintenanceStatus>;
  readonly renew: (requestId: string) => Effect.Effect<MaintenanceStatus>;
  readonly release: (requestId: string) => Effect.Effect<MaintenanceStatus>;
  readonly resumeRecovery: Effect.Effect<MaintenanceStatus, RecoveryHold.RecoveryHoldError>;
}

export class MaintenanceGate extends Context.Reference<MaintenanceGateService>(
  "stark-code/maintenance/MaintenanceGate",
  {
    defaultValue: () => {
      const status: MaintenanceStatus = {
        requestId: null,
        state: "open",
        ready: false,
        blockers: [],
        leaseExpiresAtUnixMs: null,
        recoveryHold: null,
      };
      return {
        status: Effect.succeed(status),
        guard: (_source, effect) => Effect.asSome(effect),
        refusal: () => Effect.succeedNone,
        admits: () => Effect.succeed(true),
        hasActiveWork: () => Effect.succeed(false),
        claimsPaused: Effect.succeed(false),
        restartContinuationsHeld: Effect.succeed(false),
        prepare: () => Effect.succeed(status),
        renew: () => Effect.succeed(status),
        release: () => Effect.succeed(status),
        resumeRecovery: Effect.succeed(status),
      };
    },
  },
) {}

interface GateState {
  readonly phase: "open" | "closing" | "closed";
  readonly requestId: string | null;
  readonly mode: MaintenancePrepareMode;
  readonly leaseExpiresAtMs: number | null;
  readonly blockers: ReadonlyArray<MaintenanceBlocker>;
  /** Admitted root work still being recorded; it blocks like a run. */
  readonly inFlight: ReadonlyMap<MaintenanceSource, number>;
}

const OPEN: Omit<GateState, "inFlight"> = {
  phase: "open",
  requestId: null,
  mode: "probe",
  leaseExpiresAtMs: null,
  blockers: [],
};

const HOLD_SOURCES: ReadonlySet<MaintenanceSource> = new Set([
  "scheduler",
  "webhook",
  "storage-cleanup",
]);

const changeInFlight = (
  inFlight: ReadonlyMap<MaintenanceSource, number>,
  source: MaintenanceSource,
  delta: number,
) => {
  const next = new Map(inFlight);
  const count = (next.get(source) ?? 0) + delta;
  if (count <= 0) next.delete(source);
  else next.set(source, count);
  return next;
};

const encodeLastRunningVersion = Schema.encodeSync(Schema.fromJsonString(LastRunningVersion));

const readScheduledRunBlockers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_runs'
  `;
  if (table.length === 0) return [];
  return yield* sql<{ readonly id: string; readonly thread_id: string | null }>`
    SELECT run_id AS id, thread_id FROM scheduled_task_runs
    WHERE dispatch_state IN ('waiting', 'dispatching')
  `;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = NodePath.dirname(config.dbPath);
  const runningVersion = (yield* AppBuild.current).version;
  const initialHold = yield* RecoveryHold.read(stateDir).pipe(
    // An unreadable hold still holds: releasing background work by mistake can replay it.
    Effect.catch((error) =>
      Effect.logWarning("Could not read the recovery hold; holding background work", {
        error,
      }).pipe(
        Effect.as(
          Option.some<MaintenanceRecoveryHold>({
            version: 1,
            backupId: "unknown",
            backupAppVersion: "unknown",
            displacedPath: "",
            heldSince: "",
          }),
        ),
      ),
    ),
  );
  const hold = yield* Ref.make(initialHold);
  const state = yield* Ref.make<GateState>({ ...OPEN, inFlight: new Map() });
  const transitions = yield* Semaphore.make(1);

  /** The state, with an expired lease reopening the gate. */
  const current = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [expired, next] = yield* Ref.modify(
      state,
      (gate): readonly [readonly [string | null, GateState], GateState] => {
        if (
          gate.phase !== "open" &&
          gate.leaseExpiresAtMs !== null &&
          now >= gate.leaseExpiresAtMs
        ) {
          const reopened: GateState = { ...OPEN, inFlight: gate.inFlight };
          return [[gate.requestId, reopened], reopened];
        }
        return [[null, gate], gate];
      },
    );
    if (expired !== null) {
      yield* Effect.logWarning("The maintenance lease expired; the gate reopened", {
        requestId: expired,
      });
    }
    return next;
  });

  const toStatus = (gate: GateState, holdValue: Option.Option<MaintenanceRecoveryHold>) =>
    ({
      requestId: gate.requestId,
      state: gate.phase,
      ready: gate.phase === "closed" && gate.blockers.length === 0,
      blockers: gate.blockers,
      leaseExpiresAtUnixMs: gate.leaseExpiresAtMs,
      recoveryHold: Option.getOrNull(holdValue),
    }) satisfies MaintenanceStatus;

  const status = Effect.gen(function* () {
    return toStatus(yield* current, yield* Ref.get(hold));
  });

  const refusal = (gate: GateState, held: boolean, source: MaintenanceSource) =>
    gate.phase !== "open"
      ? new MaintenanceInProgressError({ source, reason: "update" })
      : held && HOLD_SOURCES.has(source)
        ? new MaintenanceInProgressError({ source, reason: "recovery-hold" })
        : null;

  const refusalNow = (source: MaintenanceSource) =>
    Effect.gen(function* () {
      return Option.fromNullishOr(
        refusal(yield* current, Option.isSome(yield* Ref.get(hold)), source),
      );
    });
  const admits = (source: MaintenanceSource) => Effect.map(refusalNow(source), Option.isNone);

  const guard = <A, E, R>(source: MaintenanceSource, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const gate = yield* current;
      const held = Option.isSome(yield* Ref.get(hold));
      const refused = yield* Ref.modify(state, (latest) => {
        // `current` may have reopened an expired gate; re-check against the latest state.
        const error = refusal(latest.phase === gate.phase ? latest : gate, held, source);
        return error === null
          ? ([null, { ...latest, inFlight: changeInFlight(latest.inFlight, source, 1) }] as const)
          : ([error, latest] as const);
      });
      if (refused !== null) return Option.none<A>();
      return yield* effect.pipe(
        Effect.asSome,
        Effect.ensuring(
          Ref.update(state, (latest) => ({
            ...latest,
            inFlight: changeInFlight(latest.inFlight, source, -1),
          })),
        ),
      );
    });

  const readBlockers = Effect.gen(function* () {
    const projection = yield* readMaintenanceBlockers().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const scheduled = yield* readScheduledRunBlockers.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const inFlight = (yield* Ref.get(state)).inFlight;
    return [
      ...projection.map((row): MaintenanceBlocker => ({
        kind: row.kind,
        id: row.id,
        threadId: row.thread_id,
      })),
      ...scheduled.map((row): MaintenanceBlocker => ({
        kind: "scheduled-run",
        id: row.id,
        threadId: row.thread_id,
      })),
      ...[...inFlight.entries()].map(([source, count]): MaintenanceBlocker => ({
        kind: "admission",
        id: `${source}:${count}`,
        threadId: null,
      })),
    ];
  }).pipe(
    // An unreadable state cannot prove the backend idle.
    Effect.catch((error) =>
      Effect.logWarning("Could not read maintenance blockers", { error }).pipe(
        Effect.as<ReadonlyArray<MaintenanceBlocker>>([
          { kind: "admission", id: "unreadable", threadId: null },
        ]),
      ),
    ),
  );

  const hasActiveWork = (threadIds: ReadonlyArray<string>) =>
    readBlockers.pipe(
      Effect.map((blockers) =>
        blockers.some(
          (blocker) =>
            (blocker.kind === "run" || blocker.kind === "provider-work") &&
            blocker.threadId !== null &&
            threadIds.includes(blocker.threadId),
        ),
      ),
    );

  /**
   * Closes (or keeps closed) the gate for `requestId` and reports whether the
   * backend can stop. Refusing new work comes first, so the blocker read
   * after it cannot miss work admitted in between; claims pause only once
   * nothing blocks, and a second read catches an effect claimed just before.
   */
  const evaluate = (requestId: string, mode: MaintenancePrepareMode | null) =>
    transitions.withPermits(1)(
      Effect.gen(function* () {
        const gate = yield* current;
        if (gate.phase !== "open" && gate.requestId !== requestId) {
          return toStatus(gate, yield* Ref.get(hold));
        }
        // A renewal after the lease expired does not silently close again.
        if (mode === null && gate.phase === "open") return toStatus(gate, yield* Ref.get(hold));
        const effectiveMode = mode ?? gate.mode;
        const leaseExpiresAtMs = (yield* Clock.currentTimeMillis) + MAINTENANCE_LEASE_MS;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          phase: latest.phase === "closed" ? ("closed" as const) : ("closing" as const),
          requestId,
          mode: effectiveMode,
          leaseExpiresAtMs,
        }));
        let blockers = yield* readBlockers;
        if (blockers.length === 0) {
          yield* Ref.update(state, (latest): GateState => ({ ...latest, phase: "closed" }));
          blockers = yield* readBlockers;
        }
        const next = yield* Ref.updateAndGet(state, (latest): GateState =>
          blockers.length === 0
            ? { ...latest, blockers: [] }
            : mode === "probe"
              ? { ...OPEN, inFlight: latest.inFlight, blockers }
              : { ...latest, phase: "closing" as const, blockers },
        );
        if (mode !== null) {
          yield* Effect.logInfo("Maintenance gate prepared", {
            requestId,
            mode: effectiveMode,
            state: next.phase,
            blockers: blockers.length,
          });
        }
        return toStatus(next, yield* Ref.get(hold));
      }),
    );

  const release = (requestId: string) =>
    transitions.withPermits(1)(
      Effect.gen(function* () {
        const gate = yield* current;
        if (gate.requestId === requestId) {
          yield* Ref.update(state, (latest) => ({ ...OPEN, inFlight: latest.inFlight }));
          yield* Effect.logInfo("Maintenance gate released", { requestId });
        }
        return yield* status;
      }),
    );

  const resumeRecovery = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(hold))) {
      yield* RecoveryHold.release(stateDir);
      yield* Ref.set(hold, Option.none());
      yield* Effect.logInfo("Resumed background work after a restore");
    }
    return yield* status;
  });

  // After activation: record the version that ran successfully, then prune
  // backups now that this version is committed. A recovery hold keeps every
  // backup until the user resumes.
  yield* forkParked(
    Effect.gen(function* () {
      const ops = yield* StateFiles.StateFileOps;
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.try(() =>
        StateFiles.writeFileDurably(
          ops,
          NodePath.join(stateDir, LAST_RUNNING_VERSION_FILE),
          `${encodeLastRunningVersion({ version: runningVersion, recordedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) })}\n`,
        ),
      );
      if (Option.isSome(yield* Ref.get(hold))) return;
      yield* StateBackupRetention.apply({
        baseDir: config.baseDir,
        dbPath: config.dbPath,
        runningVersion,
        nowMs: now,
      });
    }).pipe(Effect.ignore({ log: true })),
  );

  return {
    status,
    guard,
    refusal: refusalNow,
    admits,
    hasActiveWork,
    claimsPaused: Effect.map(current, (gate) => gate.phase === "closed"),
    restartContinuationsHeld: Effect.map(Ref.get(hold), Option.isSome),
    prepare: ({ requestId, mode }) => evaluate(requestId, mode),
    renew: (requestId) => evaluate(requestId, null),
    release,
    resumeRecovery,
  } satisfies MaintenanceGateService;
}).pipe(Effect.annotateLogs({ scope: "maintenance-gate" }));

export const layer = Layer.effect(MaintenanceGate, make);
