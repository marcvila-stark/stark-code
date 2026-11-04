// @effect-diagnostics nodeBuiltinImport:off - The record is a small file next to the database, replaced with an fsync.
import * as NodePath from "node:path";

import { FAILED_UPDATE_FILE, FailedUpdate, type FailedUpdateReason } from "@starkfuture/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as StateFiles from "../persistence/StateFiles.ts";

/**
 * `failed-update.json` names an app version that failed on this data: its
 * migration failed, or the data was restored from a backup taken before it
 * was installed. The desktop updater reads it and does not offer that version
 * on its own again, so a reinstalled older app does not download and offer
 * the same failing update in a loop. It lives in the state directory, which a
 * restore does not replace, and is never backed up.
 */
const decodeFailedUpdate = Schema.decodeUnknownOption(Schema.fromJsonString(FailedUpdate));
const encodeFailedUpdate = Schema.encodeSync(Schema.fromJsonString(FailedUpdate));

const failedUpdatePath = (stateDir: string) => NodePath.join(stateDir, FAILED_UPDATE_FILE);

/** The record, or none when it is missing or unreadable. */
const read = (stateDir: string): Option.Option<FailedUpdate> => {
  try {
    return Option.flatMap(
      Option.fromNullishOr(StateFiles.readTextIfExists(failedUpdatePath(stateDir))),
      decodeFailedUpdate,
    );
  } catch {
    return Option.none();
  }
};

/**
 * Records `failedVersion`. The first reason recorded for a version stays;
 * another version replaces the record. Best effort: a failure is logged.
 */
export const record = Effect.fn("FailedUpdate.record")(
  function* (
    stateDir: string,
    input: {
      readonly failedVersion: string;
      readonly reason: FailedUpdateReason;
      readonly fromVersion: string | null;
    },
  ) {
    const existing = read(stateDir);
    if (Option.isSome(existing) && existing.value.failedVersion === input.failedVersion) return;
    const ops = yield* StateFiles.StateFileOps;
    const recordedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* Effect.try(() =>
      StateFiles.writeFileDurably(
        ops,
        failedUpdatePath(stateDir),
        `${encodeFailedUpdate({ version: 1, ...input, recordedAt })}\n`,
      ),
    );
    yield* Effect.logWarning("Recorded an update that failed on this data", {
      failedVersion: input.failedVersion,
      reason: input.reason,
    });
  },
  Effect.ignore({ log: true }),
);
