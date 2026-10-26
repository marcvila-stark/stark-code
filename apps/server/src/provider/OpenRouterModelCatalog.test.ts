import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { checkOpenRouterKey, fetchOpenRouterModelCatalog } from "./OpenRouterModelCatalog.ts";

const row = (id: string, changes = {}) => ({
  id,
  name: id,
  supported_parameters: ["tools"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  ...changes,
});

it.effect("publishes exact routed IDs, only text tool models, without sending credentials", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        assert.equal(request.url, "https://openrouter.ai/api/v1/models?supported_parameters=tools");
        assert.isUndefined(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              data: [
                row("openai/gpt-example"),
                row("anthropic/claude-sonnet-5.5"),
                row("anthropic/claude-haiku-5.5"),
                row("image/model", {
                  architecture: { input_modalities: ["text"], output_modalities: ["image"] },
                }),
                row("plain/model", { supported_parameters: [] }),
                row("anthropic/claude-sonnet-5.5:batch"),
              ],
            }),
          ),
        );
      }),
    );
    const result = yield* fetchOpenRouterModelCatalog().pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.deepEqual(
      result.models.map((entry) => entry.model.slug),
      ["anthropic/claude-sonnet-5.5", "openai/gpt-example"],
    );
    assert.notProperty(result.models[0]!.model, "aliases");
    assert.deepEqual(result.models[1]!.runtime, {});
  }),
);
it.effect("fails on an unavailable catalog, allowing its caller to keep the fallback", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
    );
    const result = yield* Effect.result(
      fetchOpenRouterModelCatalog().pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("verifies only the configured OpenRouter key without generating a response", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        assert.equal(request.url, "https://openrouter.ai/api/v1/key");
        calls.push(request.headers.authorization!);
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: request.headers.authorization === "Bearer valid-test-key" ? 200 : 401,
          }),
        );
      }),
    );
    const check = (key: string) =>
      checkOpenRouterKey(key).pipe(Effect.provideService(HttpClient.HttpClient, http));
    assert.equal(yield* check(""), "missing");
    assert.equal(yield* check("valid-test-key"), "valid");
    assert.equal(yield* check("invalid-test-key"), "invalid");
    assert.deepEqual(calls, ["Bearer valid-test-key", "Bearer invalid-test-key"]);
  }),
);
