// @effect-diagnostics nodeBuiltinImport:off - The maintenance lock is a native SQLite handle held for the opener's lifetime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  MAINTENANCE_LOCK_FILE,
  SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as MaintenanceIntent from "../maintenance/MaintenanceIntent.ts";
import { holdsServerOwnership } from "../serverOwnership.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateRestore from "./StateRestore.ts";

/**
 * Every process that opens the state database (the server, CLI `auth`,
 * `pair`, `project`, `backup`) holds `maintenance-owner.sqlite` in SHARED
 * mode while it has the database open. The maintenance actor (the desktop
 * app during an install, a process backing up before a migration, a restore)
 * takes it EXCLUSIVE, so while it works every other opener is refused.
 *
 * The lock is a SQLite read transaction (SHARED) or `BEGIN EXCLUSIVE` on an
 * empty database that is never in WAL mode and never unlinked; the OS
 * releases it when the process dies, even on SIGKILL.
 */
export class StateMaintenanceInProgressError extends Schema.TaggedError<StateMaintenanceInProgressError>()(
  "StateMaintenanceInProgressError",
  {
    stateDir: Schema.String,
    /** `update`: the exclusive holder is maintaining the state. `in-use`: another process has it open. */
    holder: Schema.Literals(["update", "in-use", "server"]),
  },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS;

  override get message(): string {
    switch (this.holder) {
      case "update":
        return "Stark Code is updating; try again in a moment.";
      case "in-use":
        return "Another Stark Code process is using this data. Close it and try again. Nothing was changed.";
      case "server":
        return "A Stark Code server is running on this data. Stop it before updating its database. Nothing was changed.";
    }
  }
}

export class StateAccessError extends Schema.TaggedError<StateAccessError>()("StateAccessError", {
  stateDir: Schema.String,
  operation: Schema.Literals(["lock", "resolve-intent"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not ${this.operation === "lock" ? "coordinate access to" : "finish an interrupted update of"} ${this.stateDir}.`;
  }
}

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

export type MaintenanceLockMode = "shared" | "exclusive";

export interface MaintenanceLock {
  readonly mode: () => MaintenanceLockMode;
  /** Exclusive for `effect`, then back to shared. Fails when another process holds it. */
  readonly withExclusive: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StateMaintenanceInProgressError | StateAccessError, R>;
  readonly upgrade: Effect.Effect<void, StateMaintenanceInProgressError | StateAccessError>;
  readonly downgrade: Effect.Effect<void, StateMaintenanceInProgressError | StateAccessError>;
}

const begin = (database: NodeSqlite.DatabaseSync, mode: MaintenanceLockMode) => {
  if (mode === "exclusive") {
    database.exec("BEGIN EXCLUSIVE");
    return;
  }
  database.exec("BEGIN");
  try {
    // Any read takes the SHARED lock, even on the empty file.
    database.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
};

/** Holds the maintenance lock in `mode` until the scope closes. */
export const acquireMaintenanceLock = Effect.fn("StateAccess.acquireMaintenanceLock")(function* (
  stateDir: string,
  mode: MaintenanceLockMode,
) {
  const refused = (requested: MaintenanceLockMode) =>
    new StateMaintenanceInProgressError({
      stateDir,
      holder: requested === "shared" ? "update" : "in-use",
    });
  const lockError = (requested: MaintenanceLockMode) => (cause: unknown) =>
    isSqliteBusy(cause)
      ? refused(requested)
      : new StateAccessError({ stateDir, operation: "lock", cause });

  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(stateDir, { recursive: true });
        const handle = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, MAINTENANCE_LOCK_FILE));
        try {
          handle.exec("PRAGMA busy_timeout = 0");
          begin(handle, mode);
        } catch (cause) {
          handle.close();
          throw cause;
        }
        return handle;
      },
      catch: lockError(mode),
    }),
    (handle) => Effect.sync(() => handle.close()),
  );
  let current = mode;
  const switchTo = (next: MaintenanceLockMode) =>
    Effect.try({
      try: () => {
        if (current === next) return;
        database.exec("COMMIT");
        try {
          begin(database, next);
          current = next;
        } catch (cause) {
          // Keep holding what was held; a failed downgrade can only lose a
          // race to a new exclusive holder, which then owns the state.
          try {
            begin(database, current);
          } catch {
            current = "shared";
          }
          throw cause;
        }
      },
      catch: lockError(next),
    });
  const lock: MaintenanceLock = {
    mode: () => current,
    upgrade: switchTo("exclusive"),
    downgrade: switchTo("shared"),
    withExclusive: (effect) =>
      Effect.acquireUseRelease(
        switchTo("exclusive"),
        () => effect,
        () => switchTo("shared").pipe(Effect.ignore({ log: true })),
      ),
  };
  return lock;
});

/**
 * Proves no server runs on this state for the scope's lifetime, by holding
 * `server-owner.sqlite` the way a server does. A process that already owns
 * the state (the server itself) passes without a second handle.
 */
export const excludeServer = Effect.fn("StateAccess.excludeServer")(function* (stateDir: string) {
  if (holdsServerOwnership(stateDir)) return;
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(stateDir, { recursive: true });
        const handle = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "server-owner.sqlite"));
        try {
          handle.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        } catch (cause) {
          handle.close();
          throw cause;
        }
        return handle;
      },
      catch: (cause) =>
        isSqliteBusy(cause)
          ? new StateMaintenanceInProgressError({ stateDir, holder: "server" })
          : new StateAccessError({ stateDir, operation: "lock", cause }),
    }),
    (handle) => Effect.sync(() => handle.close()),
  );
});

/**
 * Settles what a maintenance actor that died left behind, under the
 * exclusive lock: an interrupted restore is finished or undone by its
 * journal, unpublished backup staging is removed, and the intent is cleared.
 * The state the owner started from stays usable in every phase.
 */
const resolveAbandonedMaintenance = Effect.fn("StateAccess.resolveAbandonedMaintenance")(
  function* (input: { readonly stateDir: string; readonly baseDir: string }) {
    const intent = yield* MaintenanceIntent.read(input.stateDir);
    const restored = yield* StateRestore.recoverInterrupted(input.baseDir);
    const staging = yield* StateBackup.removeStaleStaging(input.baseDir);
    if (Option.isSome(intent)) yield* MaintenanceIntent.clear(input.stateDir);
    if (Option.isSome(intent) || Option.isSome(restored) || staging > 0) {
      yield* Effect.logWarning("Resolved an interrupted Stark Code update or restore", {
        phase: Option.getOrUndefined(Option.map(intent, (value) => value.phase)),
        restore: Option.getOrUndefined(Option.map(restored, (value) => value.outcome)),
        removedStaging: staging,
      });
    }
  },
);

const hasAbandonedMaintenance = (input: { readonly stateDir: string; readonly baseDir: string }) =>
  NodeFS.existsSync(MaintenanceIntent.intentPath(input.stateDir)) ||
  NodeFS.existsSync(StateRestore.journalPath(input.baseDir));

/**
 * The entry point for every database opener. Holds the maintenance lock
 * SHARED for the scope's lifetime; first settles a dead maintenance actor's
 * leftovers when they exist (briefly exclusive). Refuses with
 * `StateMaintenanceInProgressError` while an update, backup or restore holds
 * the state.
 */
export const open = Effect.fn("StateAccess.open")(function* (input: {
  readonly stateDir: string;
  readonly baseDir: string;
}): Effect.fn.Return<
  MaintenanceLock,
  StateMaintenanceInProgressError | StateAccessError,
  Scope.Scope
> {
  const lock = yield* acquireMaintenanceLock(input.stateDir, "shared");
  if (hasAbandonedMaintenance(input)) {
    // A live owner would hold the lock exclusively, so getting here means it
    // died. If another opener holds it shared, that opener already settled it.
    yield* lock
      .withExclusive(
        resolveAbandonedMaintenance(input).pipe(
          Effect.mapError(
            (cause) =>
              new StateAccessError({
                stateDir: input.stateDir,
                operation: "resolve-intent",
                cause,
              }),
          ),
        ),
      )
      .pipe(
        Effect.catchTags({
          StateMaintenanceInProgressError: (error) =>
            error.holder === "in-use" ? Effect.void : Effect.fail(error),
        }),
      );
  }
  return lock;
});
