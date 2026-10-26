import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect.each([undefined, false, true])(
  "never collects or exports usage when opt-in is %s",
  (enabled) =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const collector = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request.url);
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.usage", { index });
        }
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          AnalyticsService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                collector,
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    STARK_CODE_TELEMETRY_ENABLED: enabled,
                    STARK_CODE_POSTHOG_KEY: "test-key",
                    STARK_CODE_POSTHOG_HOST: "https://collector.example.test",
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(requests, []);
    }),
);

it.effect("requires no filesystem, credentials, identifier, or network services", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("test.no-dependencies");
    yield* analytics.flush;
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
