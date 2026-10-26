import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as OtlpEndpointCheck from "./OtlpEndpointCheck.ts";

it.effect("does not probe a collector for any signal", () =>
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
      const endpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
      for (const signal of ["traces", "metrics", "logs"] as const) {
        assert.deepEqual(
          yield* endpointCheck.check({
            signal,
            url: `https://collector.example.test/v1/${signal}`,
          }),
          { _tag: "Unreachable", timedOut: false },
        );
      }
    }).pipe(Effect.provide(OtlpEndpointCheck.layer.pipe(Layer.provide(collector))));
    assert.deepEqual(requests, []);
  }),
);
