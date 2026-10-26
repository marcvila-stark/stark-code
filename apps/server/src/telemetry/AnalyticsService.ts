import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Compatibility service for callers; this app does not collect usage events. */
export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("stark-code/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({ record: () => Effect.void, flush: Effect.void }),
  );
}

// No identifier, buffer, exporter, or environment switch exists in this build.
export const layer = AnalyticsService.layerTest;
