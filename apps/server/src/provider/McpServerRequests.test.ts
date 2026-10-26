import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type McpServerSignInStart,
  type McpServerStatusEntry,
} from "@starkfuture/contracts";
import type { ProviderAdapterV2McpServers } from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeForResolver } from "./McpServerRequests.ts";

const target = { threadId: ThreadId.make("thread") };
const desktop = { desktopHost: true };
const remote = { desktopHost: false };
const setup = (
  input: {
    signIn?: McpServerSignInStart;
    servers?: readonly McpServerStatusEntry[];
    reload?: ProviderAdapterV2McpServers["reload"];
  } = {},
) => {
  const calls: string[] = [];
  const api: ProviderAdapterV2McpServers = {
    reconnectScope: "server",
    ...(input.reload ? { reload: input.reload } : {}),
    list: () => Effect.succeed(input.servers ?? []),
    reconnect: (name) =>
      Effect.sync(() => {
        calls.push(`reconnect:${name}`);
      }),
    setEnabled: (name, enabled) =>
      Effect.sync(() => {
        calls.push(`enabled:${name}:${enabled}`);
      }),
    startSignIn: () =>
      Effect.succeed(
        input.signIn ?? {
          url: "https://auth.test/authorize?state=expected",
          callbackExpected: true,
          redirectScheme: "localhost",
          callbackPort: 48391,
          state: "expected",
        },
      ),
    submitCallback: (name) =>
      Effect.sync(() => {
        calls.push(`callback:${name}`);
      }),
    signOut: (name) =>
      Effect.sync(() => {
        calls.push(`signOut:${name}`);
      }),
  };
  return { calls, api, service: makeForResolver(() => Effect.succeed(api)) };
};

it.effect("returns no live data without starting a missing runtime", () =>
  Effect.gen(function* () {
    const service = makeForResolver(() => Effect.succeed(undefined));
    assert.deepEqual(yield* service.list(target), { servers: [], live: false });
  }),
);

it.effect("never resolves a cold project status client for a remote viewer", () =>
  Effect.gen(function* () {
    let lookups = 0;
    const service = makeForResolver(() =>
      Effect.sync(() => {
        lookups++;
        return undefined;
      }),
    );
    const project = {
      projectId: ProjectId.make("project"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    };
    assert.deepEqual(yield* service.list(project, remote), { servers: [], live: false });
    assert.equal(lookups, 0);
    yield* service.list(project, desktop);
    assert.equal(lookups, 1);
  }),
);

it.effect("keeps remote viewers read-only and locks the app server on every action", () =>
  Effect.gen(function* () {
    const { service, calls } = setup();
    const input = { ...target, name: "third-party" };
    for (const effect of [
      service.reconnect(input, remote),
      service.setEnabled({ ...input, enabled: false }, remote),
      service.signIn(input, remote),
      service.submitCallback({ ...input, url: "http://localhost" }, remote),
      service.signOut(input, remote),
    ])
      assert.isTrue((yield* Effect.result(effect))._tag === "Failure");
    const locked = { ...target, name: "STARK-CODE" };
    for (const effect of [
      service.reconnect(locked, desktop),
      service.setEnabled({ ...locked, enabled: false }, desktop),
      service.signIn(locked, desktop),
      service.submitCallback({ ...locked, url: "http://localhost" }, desktop),
      service.signOut(locked, desktop),
    ])
      assert.isTrue((yield* Effect.result(effect))._tag === "Failure");
    assert.deepEqual(calls, []);
  }),
);

it.effect("binds callbacks to an unexpired sign-in flow and consumes them once", () =>
  Effect.gen(function* () {
    const { service, calls } = setup();
    const input = { ...target, name: "third-party" };
    yield* service.signIn(input, desktop);
    const url = "http://localhost:48391/callback?code=secret&state=expected";
    assert.isTrue(
      (yield* Effect.result(
        service.submitCallback({ ...input, url: url.replace("expected", "wrong") }, desktop),
      ))._tag === "Failure",
    );
    yield* service.submitCallback({ ...input, url }, desktop);
    assert.isTrue(
      (yield* Effect.result(service.submitCallback({ ...input, url }, desktop)))._tag === "Failure",
    );
    yield* service.signIn(input, desktop);
    yield* TestClock.adjust("6 minutes");
    assert.isTrue(
      (yield* Effect.result(service.submitCallback({ ...input, url }, desktop)))._tag === "Failure",
    );
    assert.deepEqual(calls, ["callback:third-party"]);
  }),
);

it.effect("rejects untrusted browser metadata and supports an already completed CLI fallback", () =>
  Effect.gen(function* () {
    const input = { ...target, name: "third-party" };
    const rejected = setup({ signIn: { url: "javascript:alert(1)", callbackExpected: false } });
    assert.isTrue(
      (yield* Effect.result(rejected.service.signIn(input, desktop)))._tag === "Failure",
    );
    const completed = setup({
      signIn: { browserOpened: true, completed: true, callbackExpected: false },
    });
    assert.deepEqual(yield* completed.service.signIn(input, desktop), {
      browserOpened: true,
      completed: true,
      callbackExpected: false,
    });
  }),
);

it.effect("requires a local desktop before resolving either reload target", () =>
  Effect.gen(function* () {
    let resolutions = 0;
    const service = makeForResolver(() =>
      Effect.sync(() => {
        resolutions++;
        return undefined;
      }),
    );
    for (const input of [
      target,
      {
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        projectId: ProjectId.make("project"),
        force: true,
      },
    ]) {
      const denied = yield* service.reload(input, remote).pipe(Effect.flip);
      assert.equal(denied.reason, "desktop_required");
    }
    assert.equal(resolutions, 0);
  }),
);

it.effect("advertises reload support and requires an explicit force after a held reload", () =>
  Effect.gen(function* () {
    const requests: boolean[] = [];
    const { service } = setup({
      reload: ({ force }) =>
        Effect.sync(() => {
          requests.push(force);
          return force
            ? {
                status: "reloaded" as const,
                failedServers: [
                  "\u001b[31mdocs\u001b[0m",
                  "docs",
                  "Authorization: token https://auth.test?code=secret",
                ],
                pluginErrors: 2,
              }
            : { status: "confirmation-required" as const, failedServers: [] };
        }),
    });
    assert.isTrue((yield* service.list(target, desktop)).canReload);
    assert.isFalse((yield* service.list(target, remote)).canReload);
    assert.deepEqual(yield* service.reload(target, desktop), {
      status: "confirmation-required",
      failedServers: [],
    });
    assert.deepEqual(requests, [false]);
    const applied = yield* service.reload({ ...target, force: true }, desktop);
    assert.equal(applied.status, "reloaded");
    assert.equal(applied.pluginErrors, 2);
    assert.deepEqual(applied.failedServers, ["docs", "Authorization: [redacted]"]);
    assert.deepEqual(requests, [false, true]);
  }),
);

it.effect("does not emulate reload for a provider without native reload support", () =>
  Effect.gen(function* () {
    const { service, calls } = setup();
    assert.isFalse((yield* service.list(target, desktop)).canReload);
    assert.equal((yield* service.reload(target, desktop).pipe(Effect.flip)).reason, "unavailable");
    assert.deepEqual(calls, []);
  }),
);

it.effect("never reloads or creates a Settings inspection session for a project-only target", () =>
  Effect.gen(function* () {
    let resolutions = 0;
    let reloads = 0;
    const { api } = setup({
      reload: () =>
        Effect.sync(() => {
          reloads++;
          return { status: "reloaded" as const, failedServers: [] };
        }),
    });
    const service = makeForResolver(() =>
      Effect.sync(() => {
        resolutions++;
        return api;
      }),
    );
    const project = {
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      projectId: ProjectId.make("project"),
    };
    for (const force of [false, true]) {
      const denied = yield* service.reload({ ...project, force }, desktop).pipe(Effect.flip);
      assert.equal(denied.reason, "unavailable");
      assert.include(denied.message, "Open a live conversation");
    }
    assert.equal(resolutions, 0);
    assert.equal(reloads, 0);
    const inspected = yield* service.list(project, desktop);
    assert.isFalse(inspected.canReload);
    assert.isFalse(inspected.live);
    assert.equal(resolutions, 1);
    assert.equal(reloads, 0);
    assert.isTrue((yield* service.list(target, desktop)).canReload);
    yield* service.reload(target, desktop);
    assert.equal(reloads, 1);
  }),
);

it.effect("escapes status metadata and redacts callback parameters and auth headers", () =>
  Effect.gen(function* () {
    const { service } = setup({
      servers: [
        {
          name: "\u001b[31mstark-code\u001b[0m",
          locked: false,
          status: "failed",
          authKind: "unknown",
          tools: [],
          error: "Authorization: secret https://oauth.test/?code=one&state=two&token=three",
        },
      ],
    });
    const server = (yield* service.list(target)).servers[0];
    assert.equal(server?.name, "stark-code");
    assert.isTrue(server?.locked);
    assert.isFalse(server?.error?.includes("secret"));
    for (const secret of ["=one", "=two", "=three"])
      assert.isFalse(server?.error?.includes(secret));
  }),
);

it.effect("advertises targeted reconnect support and refuses unknown or global reconnects", () =>
  Effect.gen(function* () {
    const { service, api, calls } = setup();
    assert.equal((yield* service.list(target, desktop)).reconnectScope, "server");
    yield* service.reconnect({ ...target, name: "failed" }, desktop);
    assert.deepEqual(calls, ["reconnect:failed"]);
    for (const scope of ["all", undefined] as const) {
      const { reconnectScope: _scope, ...withoutScope } = api;
      const unsupported = makeForResolver(() =>
        Effect.succeed({ ...withoutScope, ...(scope ? { reconnectScope: scope } : {}) }),
      );
      assert.equal((yield* unsupported.list(target, desktop)).reconnectScope, scope);
      const error = yield* unsupported
        .reconnect({ ...target, name: "failed" }, desktop)
        .pipe(Effect.flip);
      assert.equal(error.reason, "unavailable");
      assert.include(error.message, "affecting other connections");
    }
    assert.deepEqual(calls, ["reconnect:failed"]);
  }),
);

it.effect("keeps connection summaries while stripping URL secrets and credential fields", () =>
  Effect.gen(function* () {
    const errors = [
      "ECONNREFUSED connecting to https://alice:secret-pass@private.example/mcp/private-path?refresh_token=refresh-value&client_secret=client-value#fragment-secret",
      "DNS lookup failed\nAuthorization: Bearer auth-secret\nCookie: session=cookie-secret; csrf=csrf-secret\nx-api-key: api-secret\nSet-Cookie: session=new-secret; HttpOnly",
      '{"refresh_token":"refresh-json", "client_secret":"client-json", "Authorization":"Bearer json-auth", "Cookie":"json-cookie", "x-api-key":"json-api"}',
      "invalid_grant refresh_token=refresh-bare client_secret=client-bare access_token=access-bare code=code-bare state=state-bare",
      "Proxy-Authorization: Basic proxy-secret\nFailed to connect.",
      "TLS error at wss://alice:ws-secret@socket.example/private?key=unknown-secret#opaque-secret",
      "Timed out\nAuthorization: " + "long-secret".repeat(300),
      String.raw`{"Authorization":"Bearer prefix\"escaped-auth", "client_secret":"prefix\"escaped-client"}`,
      "Auth\u001b[31morization\u001b[0m: Bearer terminal-secret\nrefresh_\u200btoken=hidden-secret",
      "postgres://user:database-secret@db.example/private redis://user:redis-secret@cache.example mongodb+srv://user:mongo-secret@cluster.example/private",
      "apiKey=camel-secret secret=bare-secret AWS_SECRET_ACCESS_KEY=aws-secret oauthToken=camel-token",
      "Key refused: sk-live-visible-key ghp_visiblegithubkey github_pat_visiblepat",
    ];
    const { service } = setup({
      servers: errors.map((error, index) => ({
        name: `server-${index}`,
        status: "failed",
        authKind: "unknown",
        locked: false,
        tools: [],
        error,
      })),
    });
    const rows = (yield* service.list(target, desktop)).servers;
    assert.equal(rows[0]?.error, "ECONNREFUSED connecting to https://private.example");
    assert.include(rows[1]?.error ?? "", "DNS lookup failed");
    assert.include(rows[3]?.error ?? "", "invalid_grant");
    assert.include(rows[4]?.error ?? "", "Failed to connect.");
    assert.equal(rows[5]?.error, "TLS error at wss://socket.example");
    const visible = rows.map((row) => row.error).join("\n");
    for (const secret of [
      "alice",
      "secret-pass",
      "private-path",
      "refresh-value",
      "client-value",
      "fragment-secret",
      "auth-secret",
      "cookie-secret",
      "csrf-secret",
      "api-secret",
      "new-secret",
      "refresh-json",
      "client-json",
      "json-auth",
      "json-cookie",
      "json-api",
      "refresh-bare",
      "client-bare",
      "access-bare",
      "code-bare",
      "state-bare",
      "proxy-secret",
      "ws-secret",
      "unknown-secret",
      "opaque-secret",
      "long-secret",
      "escaped-auth",
      "escaped-client",
      "terminal-secret",
      "hidden-secret",
      "database-secret",
      "redis-secret",
      "mongo-secret",
      "camel-secret",
      "bare-secret",
      "aws-secret",
      "camel-token",
      "sk-live-visible-key",
      "ghp_visiblegithubkey",
      "github_pat_visiblepat",
    ])
      assert.isFalse(visible.includes(secret), `Leaked ${secret}`);
    assert.isTrue(rows.every((row) => (row.error?.length ?? 0) <= 1000));
  }),
);
