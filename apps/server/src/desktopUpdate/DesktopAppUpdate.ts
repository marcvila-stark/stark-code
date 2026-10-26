import {
  ServerSelfUpdateError,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class DesktopAppUpdate extends Context.Service<
  DesktopAppUpdate,
  {
    readonly available: boolean;
    readonly run: (
      reportProgress: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commit: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("stark-code/desktopUpdate/DesktopAppUpdate") {}

export const make = Effect.fn("desktopUpdate.desktopAppUpdate.make")(function* () {
  return DesktopAppUpdate.of({
    available: false,
    run: () =>
      Effect.fail(
        new ServerSelfUpdateError({
          reason: "Application updates are not configured for this build.",
        }),
      ),
    commit: () =>
      Effect.fail(
        new ServerSelfUpdateError({
          reason: "Application updates are not configured for this build.",
        }),
      ),
  });
});
export const layer = Layer.effect(DesktopAppUpdate, make());
