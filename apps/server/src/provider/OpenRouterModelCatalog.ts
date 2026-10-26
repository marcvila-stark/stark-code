import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  isClaudeHaikuModel,
  OPENROUTER_DEFAULT_MODEL,
} from "@starkfuture/shared/claudeModelPolicy";
import type { ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";

const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      supported_parameters: Schema.Array(Schema.String),
      architecture: Schema.Struct({
        input_modalities: Schema.Array(Schema.String),
        output_modalities: Schema.Array(Schema.String),
      }),
    }),
  ),
});

export const OPENROUTER_FALLBACK_CATALOG: ClaudeModelCatalog = {
  models: [
    {
      model: {
        slug: OPENROUTER_DEFAULT_MODEL,
        name: "Claude Sonnet 5.5 · OpenRouter",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      runtime: {},
      compatibility: {},
    },
  ],
};

/** Public discovery requires no credential and never sends the user's key. */
export const fetchOpenRouterModelCatalog = Effect.fn("fetchOpenRouterModelCatalog")(function* () {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .execute(
      HttpClientRequest.get("https://openrouter.ai/api/v1/models?supported_parameters=tools"),
    )
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  const models = catalog.data.filter(
    (model) =>
      model.id.includes("/") &&
      !model.id.includes(":batch") &&
      !isClaudeHaikuModel(model.id) &&
      model.supported_parameters.includes("tools") &&
      model.architecture.input_modalities.includes("text") &&
      model.architecture.output_modalities.includes("text"),
  );
  models.sort(
    (a, b) =>
      Number(b.id === OPENROUTER_DEFAULT_MODEL) - Number(a.id === OPENROUTER_DEFAULT_MODEL) ||
      a.name.localeCompare(b.name),
  );
  if (models.length === 0) return OPENROUTER_FALLBACK_CATALOG;
  return {
    models: models.map((model) => ({
      model: {
        slug: model.id,
        name: model.name,
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      runtime: {},
      compatibility: {},
    })),
  } satisfies ClaudeModelCatalog;
}, Effect.timeout("10 seconds"));

/** Validate the configured key without making a model request or reading account contents. */
export const checkOpenRouterKey = Effect.fn("checkOpenRouterKey")(
  function* (key: string) {
    if (!key.trim()) return "missing" as const;
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get("https://openrouter.ai/api/v1/key").pipe(
        HttpClientRequest.bearerToken(key),
      ),
    );
    if (response.status === 200) return "valid" as const;
    if (response.status === 401 || response.status === 403) return "invalid" as const;
    return "unavailable" as const;
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => "unavailable" as const),
);
