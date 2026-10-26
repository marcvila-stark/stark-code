/**
 * StarkProjectFileLoader - Effect service that loads the checked-in `stark.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module StarkProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { STARK_PROJECT_FILE_NAME, type StarkProjectFile } from "@starkfuture/contracts";
import { StarkProjectFileFromJson } from "@starkfuture/shared/starkProjectFile";

const decodeStarkProjectFileJson = Schema.decodeEffect(StarkProjectFileFromJson);

export class StarkProjectFileLoadError extends Schema.TaggedError<StarkProjectFileLoadError>()(
  "StarkProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${STARK_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for stark.json project file loading. */
export class StarkProjectFileLoader extends Context.Service<
  StarkProjectFileLoader,
  {
    /**
     * Load and decode `stark.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<StarkProjectFile>>;
  }
>()("stark-code/project/StarkProjectFileLoader") {}

const logStarkProjectFileLoadError = (error: StarkProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: StarkProjectFileLoader["Service"]["load"] = Effect.fn("StarkProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, STARK_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logStarkProjectFileLoadError(
                  new StarkProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<StarkProjectFile>();
      }
      return yield* decodeStarkProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logStarkProjectFileLoadError(
              new StarkProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<StarkProjectFile>())),
        }),
      );
    },
  );

  return StarkProjectFileLoader.of({ load });
});

export const layer = Layer.effect(StarkProjectFileLoader, make);
