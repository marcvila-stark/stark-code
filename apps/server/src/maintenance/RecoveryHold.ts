// @effect-diagnostics nodeBuiltinImport:off - The hold file is read before any Effect platform service exists and removed with an fsync.
import * as NodePath from "node:path";

import {
  RECOVERY_HOLD_FILE,
  MaintenanceRecoveryHold,
  type MaintenanceRecoveryHold as MaintenanceRecoveryHoldValue,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as StateFiles from "../persistence/StateFiles.ts";

/**
 * `recovery-hold.json` is written by a restore and stays until the user
 * resumes. While it exists, every boot holds scheduled tasks, usage-limit
 * recovery, restart continuations, webhooks and storage cleanup, so a
 * rolled-back schedule or continuation cannot replay work. Its absence is
 * the only way out; a corrupt file still holds.
 */
export class RecoveryHoldError extends Schema.TaggedError<RecoveryHoldError>()(
  "RecoveryHoldError",
  { operation: Schema.Literals(["read", "release"]), path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the recovery hold at ${this.path}.`;
  }
}

const decodeHold = Schema.decodeUnknownOption(Schema.fromJsonString(MaintenanceRecoveryHold));

const holdPath = (stateDir: string) => NodePath.join(stateDir, RECOVERY_HOLD_FILE);

export const read = Effect.fn("RecoveryHold.read")(function* (stateDir: string) {
  const path = holdPath(stateDir);
  const text = yield* Effect.try({
    try: () => StateFiles.readTextIfExists(path),
    catch: (cause) => new RecoveryHoldError({ operation: "read", path, cause }),
  });
  if (text === null) return Option.none<MaintenanceRecoveryHoldValue>();
  return Option.some(
    Option.getOrElse(decodeHold(text), (): MaintenanceRecoveryHoldValue => ({
      version: 1,
      backupId: "unknown",
      backupAppVersion: "unknown",
      displacedPath: "",
      heldSince: "",
    })),
  );
});

export const release = Effect.fn("RecoveryHold.release")(function* (stateDir: string) {
  const ops = yield* StateFiles.StateFileOps;
  const path = holdPath(stateDir);
  yield* Effect.try({
    try: () => StateFiles.removeDurably(ops, path),
    catch: (cause) => new RecoveryHoldError({ operation: "release", path, cause }),
  });
});
