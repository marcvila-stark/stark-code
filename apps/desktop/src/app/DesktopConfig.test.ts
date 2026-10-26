import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopConfig from "./DesktopConfig.ts";

it.effect("cannot enable updates or OTLP exports with ambient environment variables", () =>
  Effect.gen(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    assert.isTrue(config.disableAutoUpdate);
    assert.isFalse(config.mockUpdates);
    assert.isTrue(Option.isNone(config.otlpTracesUrl));
    assert.isTrue(Option.isNone(config.otlpMetricsUrl));
    assert.isTrue(Option.isNone(config.otlpLogsUrl));
  }).pipe(
    Effect.provide(
      DesktopConfig.layerTest({
        STARK_CODE_DISABLE_AUTO_UPDATE: "false",
        STARK_CODE_DESKTOP_MOCK_UPDATES: "true",
        STARK_CODE_OTLP_TRACES_URL: "https://traces.example.test",
        STARK_CODE_OTLP_METRICS_URL: "https://metrics.example.test",
        STARK_CODE_OTLP_LOGS_URL: "https://logs.example.test",
      }),
    ),
  ),
);
