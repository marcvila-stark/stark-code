import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import {
  hasCloudPublicConfig,
  hostedAppUrlConfig,
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

it.effect("cannot enable hosted services through runtime or embedded configuration", () =>
  Effect.gen(function* () {
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          STARK_CODE_RELAY_URL: "https://relay.example.test",
          STARK_CODE_HOSTED_APP_URL: "https://app.example.test",
          STARK_CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
          STARK_CODE_CLERK_CLI_OAUTH_CLIENT_ID: "client",
        },
      }),
    );
    assert.isFalse(hasCloudPublicConfig);
    for (const value of [
      makeRelayUrlConfig("https://embedded.example.test").pipe(Effect.asVoid),
      hostedAppUrlConfig.pipe(Effect.asVoid),
      makeCloudCliOAuthConfig({
        clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
        clerkCliOAuthClientIdFallback: "client",
      }).pipe(Effect.asVoid),
    ]) {
      const failure = yield* value.pipe(Effect.provide(config), Effect.flip);
      assert.include(failure.message, "Hosted cloud services are not included");
    }
  }),
);
it("ignores relay tracing credentials", () =>
  assert.isNull(
    resolveRelayClientTracingConfig(
      { STARK_CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.example.test" },
      { tracesUrl: "https://traces.example.test", tracesDataset: "dataset", tracesToken: "secret" },
    ),
  ));
