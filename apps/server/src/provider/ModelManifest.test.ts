import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

import * as ModelManifest from "./ModelManifest.ts";

/**
 * Test policy: this file covers manifest machinery, not manifest contents.
 * Do not add assertions for real model slugs, names, status, aliases, or
 * profiles when editing model-manifest.json. Add tests only when fetch/cache
 * behavior or the provider-neutral resolver semantics change, and use
 * synthetic models for resolver coverage.
 */

describe("resolveProviderCatalog", () => {
  it("resolves generic model presentation through a reusable profile", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          defaults: { chat: "model-next" },
          profiles: {
            standard: {
              capabilities: {
                optionDescriptors: [
                  {
                    id: "mode",
                    label: "Mode",
                    type: "select",
                    options: [{ id: "fast", label: "Fast", isDefault: true }],
                  },
                ],
              },
              adapter: { opaque: true },
            },
          },
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              aliases: ["next"],
              status: "current",
              badge: "new",
              profile: "standard",
            },
          ],
        },
      },
    };

    const catalog = ModelManifest.resolveProviderCatalog(
      manifest,
      ProviderDriverKind.make("synthetic"),
    );
    assert.deepStrictEqual(catalog?.models[0], {
      slug: "model-next",
      name: "Model Next",
      aliases: ["next"],
      badge: "new",
      status: "current",
      capabilities: manifest.providers!.synthetic!.profiles.standard!.capabilities!,
      adapter: undefined,
      profileAdapter: { opaque: true },
    });
    assert.strictEqual(catalog?.defaultChatModel, "model-next");
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifest.ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifest.ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(
        ModelManifest.resolveProviderCatalog(invalid, ProviderDriverKind.make("synthetic")),
      );
    }
  });
});

// Remote fixtures date after the bundle so a fetch still outranks it.
it.effect("keeps model catalogs bundled without acquiring network or cache dependencies", () =>
  Effect.gen(function* () {
    const manifest = yield* ModelManifest.make;
    assert.strictEqual(yield* manifest.current, ModelManifest.BUNDLED_MODEL_MANIFEST);
    assert.strictEqual(yield* manifest.refresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
    assert.strictEqual(yield* manifest.forceRefresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
    yield* manifest.refreshInBackground;
  }),
);
