import { expect, it } from "vite-plus/test";
import { buildHostedPairingUrl, configuredHostedAppUrl, isHostedStaticApp } from "./hostedPairing";
it("cannot revive a hosted app from environment configuration", () => {
  expect(configuredHostedAppUrl()).toBe("");
  expect(isHostedStaticApp(new URL("https://app.example.test"))).toBe(false);
  expect(() =>
    buildHostedPairingUrl({ host: "https://host.example.test", token: "private" }),
  ).toThrow("not included");
});
