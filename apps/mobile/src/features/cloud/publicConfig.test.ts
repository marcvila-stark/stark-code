import { describe, expect, it } from "vite-plus/test";
import {
  hasCloudPublicConfig,
  hasTracingPublicConfig,
  resolveCloudPublicConfig,
} from "./publicConfig";
describe("cloud-free configuration", () => {
  it("ignores embedded cloud and tracing credentials", () => {
    const config = resolveCloudPublicConfig({
      clerk: { publishableKey: "key", jwtTemplate: "template" },
      relay: { url: "https://relay.example.test" },
      observability: {
        tracesUrl: "https://traces.example.test",
        tracesDataset: "dataset",
        tracesToken: "secret",
      },
    });
    expect(config.clerk.publishableKey).toBeNull();
    expect(config.relay.url).toBeNull();
    expect(config.observability.tracesToken).toBeNull();
    expect(hasCloudPublicConfig()).toBe(false);
    expect(hasTracingPublicConfig()).toBe(false);
  });
});
