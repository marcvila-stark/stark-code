import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { RelayClientTracer, withLocalTracing, withRelayClientTracing } from "./relayTracing.ts";
import * as RelayTracing from "./relayTracing.ts";

class RelayTestFailure extends Schema.TaggedError<RelayTestFailure>()("RelayTestFailure", {}) {}

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

describe("withRelayClientTracing", () => {
  it.effect("uses the product tracer only for relay operations", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(Effect.withSpan("user.operation"), Effect.withTracer(userTracer));
      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["user.operation"]);
      expect(productSpans).toEqual(["relay.operation"]);
    }),
  );

  it.effect("preserves the active tracer when product tracing is disabled", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);

      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["relay.operation"]);
    }),
  );

  it.effect("never installs an exporter even when collector configuration is supplied", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const layerHttpClient = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const layerTracing = RelayTracing.layer(
      {
        tracesUrl: "https://collector.example.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "ingest-token",
      },
      { serviceName: "relay-test", runtime: "test", client: "test" },
    ).pipe(Layer.provide(layerHttpClient));
    return Effect.gen(function* () {
      expect(Option.isNone(yield* RelayClientTracer)).toBe(true);
      yield* Effect.fail(new RelayTestFailure()).pipe(
        Effect.withSpan("relay.failed-operation"),
        withRelayClientTracing,
        Effect.exit,
      );
    }).pipe(
      Effect.provide(layerTracing),
      Effect.andThen(
        Effect.sync(() => {
          expect(fetchFn).not.toHaveBeenCalled();
        }),
      ),
    );
  });
});

describe("withLocalTracing", () => {
  it.effect("keeps local work inside a relay span off the product tracer", () =>
    Effect.gen(function* () {
      const localSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const localTracer = collectingTracer(localSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(
        Effect.withSpan("relay.connection.nested"),
        Effect.andThen(
          Effect.void.pipe(
            Effect.withSpan("sql.execute"),
            Effect.withSpan("ServerSecretStore.get"),
            withLocalTracing,
          ),
        ),
        Effect.withSpan("environment.orchestration.threadSnapshot"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(localTracer),
      );

      expect(productSpans).toEqual([
        "relay.connection.nested",
        "environment.orchestration.threadSnapshot",
      ]);
      expect(localSpans).toEqual(["sql.execute", "ServerSecretStore.get"]);
    }),
  );

  it.effect("leaves the current tracer alone outside relay tracing", () =>
    Effect.gen(function* () {
      const localSpans: Array<string> = [];

      yield* Effect.void.pipe(
        Effect.withSpan("sql.execute"),
        withLocalTracing,
        Effect.withTracer(collectingTracer(localSpans)),
      );

      expect(localSpans).toEqual(["sql.execute"]);
    }),
  );
});
