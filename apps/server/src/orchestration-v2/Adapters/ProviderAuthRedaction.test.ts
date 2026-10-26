import { expect, it } from "vite-plus/test";
import { redactProviderAuthValue } from "./ProviderAuthRedaction.ts";

it("redacts OAuth control arguments and incoming authorization URLs, including nested raw protocol JSON", () => {
  const outgoing = {
    method: "mcpServer/oauth/login",
    params: {
      name: "company",
      state: "nonce-secret",
      code: "auth-secret",
      codeVerifier: "pkce-secret",
    },
  };
  const incoming = {
    id: 4,
    result: {
      authorizationUrl: "https://auth.example/authorize?state=nonce-secret",
      accessToken: "token-secret",
    },
  };
  const raw = JSON.stringify({ direction: "incoming", payload: JSON.stringify(incoming) });
  const serialized = JSON.stringify(redactProviderAuthValue([outgoing, incoming, raw]));
  for (const secret of [
    "nonce-secret",
    "auth-secret",
    "pkce-secret",
    "token-secret",
    "https://auth.example",
  ])
    expect(serialized).not.toContain(secret);
  expect(serialized).toContain("company");
});

it("cleans callback URLs from failures and preserves ordinary tool code and source links", () => {
  expect(
    redactProviderAuthValue(
      "Login failed at http://127.0.0.1:4321/callback?code=hidden&state=nonce",
    ),
  ).not.toContain("hidden");
  expect(
    redactProviderAuthValue({
      method: "item/completed",
      code: "ENOENT",
      output: "Read https://starkfuture.com/report",
    }),
  ).toEqual({
    method: "item/completed",
    code: "ENOENT",
    output: "Read https://starkfuture.com/report",
  });
  expect(
    redactProviderAuthValue({ Authorization: "Bearer secret", client_secret: "secret" }),
  ).toEqual({ Authorization: "[REDACTED]", client_secret: "[REDACTED]" });
});
