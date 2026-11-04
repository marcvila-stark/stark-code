// @effect-diagnostics nodeBuiltinImport:off - Path joins for files read before any Effect platform service exists.
import * as NodePath from "node:path";

import {
  MAINTENANCE_INTENT_FILE,
  MaintenanceIntent,
  type MaintenanceIntent as MaintenanceIntentValue,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as StateFiles from "../persistence/StateFiles.ts";

export class MaintenanceIntentError extends Schema.TaggedError<MaintenanceIntentError>()(
  "MaintenanceIntentError",
  {
    operation: Schema.Literals(["read", "write", "clear"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the maintenance intent at ${this.path}.`;
  }
}

const decodeIntent = Schema.decodeUnknownOption(Schema.fromJsonString(MaintenanceIntent));
const encodeIntent = Schema.encodeSync(Schema.fromJsonString(MaintenanceIntent));

export const intentPath = (stateDir: string) => NodePath.join(stateDir, MAINTENANCE_INTENT_FILE);

/**
 * The intent of the process holding (or that held) the maintenance lock
 * exclusively. An unreadable intent counts as none: it was never published,
 * since writes are atomic.
 */
export const read = Effect.fn("MaintenanceIntent.read")(function* (stateDir: string) {
  const path = intentPath(stateDir);
  const text = yield* Effect.try({
    try: () => StateFiles.readTextIfExists(path),
    catch: (cause) => new MaintenanceIntentError({ operation: "read", path, cause }),
  });
  return text === null ? Option.none<MaintenanceIntentValue>() : decodeIntent(text);
});

export const write = Effect.fn("MaintenanceIntent.write")(function* (
  stateDir: string,
  intent: MaintenanceIntentValue,
) {
  const ops = yield* StateFiles.StateFileOps;
  const path = intentPath(stateDir);
  yield* Effect.try({
    try: () => StateFiles.writeFileDurably(ops, path, `${encodeIntent(intent)}\n`),
    catch: (cause) => new MaintenanceIntentError({ operation: "write", path, cause }),
  });
});

export const clear = Effect.fn("MaintenanceIntent.clear")(function* (stateDir: string) {
  const ops = yield* StateFiles.StateFileOps;
  const path = intentPath(stateDir);
  yield* Effect.try({
    try: () => StateFiles.removeDurably(ops, path),
    catch: (cause) => new MaintenanceIntentError({ operation: "clear", path, cause }),
  });
});
