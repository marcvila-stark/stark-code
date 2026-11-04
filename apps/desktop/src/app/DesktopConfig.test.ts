import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopConfig from "./DesktopConfig.ts";

const readConfig = (env: Readonly<Record<string, string | undefined>>) =>
  DesktopConfig.DesktopConfig.pipe(Effect.provide(DesktopConfig.layerTest(env)));

describe("DesktopConfig", () => {
  it.effect(
    "cannot enable updates, a feed or OTLP exports with ambient environment variables",
    () =>
      Effect.gen(function* () {
        const config = yield* readConfig({
          STARK_CODE_DISABLE_AUTO_UPDATE: "false",
          STARK_CODE_DESKTOP_MOCK_UPDATES: "true",
          STARK_CODE_DESKTOP_UPDATE_FEED: "stark",
          STARK_CODE_DESKTOP_UPDATE_URL: "https://releases.example.test/stark-code/",
          STARK_CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
          GH_TOKEN: "token",
          GITHUB_TOKEN: "token",
          STARK_CODE_OTLP_TRACES_URL: "https://traces.example.test",
          STARK_CODE_OTLP_METRICS_URL: "https://metrics.example.test",
          STARK_CODE_OTLP_LOGS_URL: "https://logs.example.test",
        });
        assert.isFalse(DesktopConfig.DESKTOP_AUTO_UPDATE_ACTIVATED);
        assert.isFalse(config.autoUpdateActivated);
        assert.isFalse(config.autoUpdateDisabledByEnv);
        assert.notProperty(config, "mockUpdates");
        assert.notProperty(config, "updateFeedUrl");
        assert.isTrue(Option.isNone(config.otlpTracesUrl));
        assert.isTrue(Option.isNone(config.otlpMetricsUrl));
        assert.isTrue(Option.isNone(config.otlpLogsUrl));
      }),
  );

  it.effect("lets STARK_CODE_DISABLE_AUTO_UPDATE only switch updates off", () =>
    Effect.gen(function* () {
      for (const value of [undefined, "", "  ", "0", "false", "FALSE", "no", "off"]) {
        const config = yield* readConfig({ STARK_CODE_DISABLE_AUTO_UPDATE: value });
        assert.isFalse(config.autoUpdateDisabledByEnv, `value ${String(value)}`);
      }
      // Anything else, a malformed value included, fails closed.
      for (const value of ["1", "true", "yes", "on", "maybe", "enable"]) {
        const config = yield* readConfig({ STARK_CODE_DISABLE_AUTO_UPDATE: value });
        assert.isTrue(config.autoUpdateDisabledByEnv, `value ${value}`);
      }
    }),
  );
});
