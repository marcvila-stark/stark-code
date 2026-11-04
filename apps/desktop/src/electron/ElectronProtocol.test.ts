import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

const layerProtocol = ElectronProtocol.layer.pipe(Layer.provide(NodeServices.layer));

const PROXY_SLOTS = 64;

// Registers the dev proxy and returns a renderer-side loader for it.
const registerDevProxy = Effect.gen(function* () {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  handleMock.mockImplementation((_scheme, nextHandler) => {
    handler = nextHandler;
  });
  const protocol = yield* ElectronProtocol.ElectronProtocol;
  yield* protocol.registerDesktopProtocol({
    scheme: "starkcode-dev",
    targetOrigin: new URL("http://127.0.0.1:5733/"),
    clerkFrontendApiHostname: undefined,
  });
  return (path = "/src/module.ts", init?: RequestInit) =>
    handler!(new Request(`starkcode-dev://app${path}`, init));
});

// Takes every proxy slot with a response whose body has not been read.
const fillSlots = (load: () => Promise<Response>) =>
  Effect.promise(() => Promise.all(Array.from({ length: PROXY_SLOTS }, () => load())));

const rejectionOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("serves the bundled client from disk without a backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      yield* fileSystem.writeFileString(`${directory}/app.js`, "export default 1;");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "starkcode",
        assetDirectory: directory,
        clerkFrontendApiHostname: undefined,
      });
      const request = (pathname: string, init?: RequestInit) =>
        Effect.promise(() => handler!(new Request(`starkcode://app${pathname}`, init)));

      // SPA routes fall back to index.html, including ones containing dots.
      const page = yield* request("/settings/connections");
      assert.equal(yield* Effect.promise(() => page.text()), "<html>app</html>");
      assert.include(page.headers.get("content-security-policy") ?? "", "default-src 'self'");
      const dottedRoute = yield* request("/environment/thread.with.dots", {
        headers: { accept: "text/html" },
      });
      assert.equal(yield* Effect.promise(() => dottedRoute.text()), "<html>app</html>");

      const script = yield* request("/app.js?v=1");
      assert.equal(yield* Effect.promise(() => script.text()), "export default 1;");
      assert.include(script.headers.get("content-type") ?? "", "javascript");

      assert.equal((yield* request("/missing.js")).status, 404);
      assert.equal((yield* request("/%2e%2e%2fsecret.txt")).status, 404);
      assert.equal((yield* request("/%invalid")).status, 400);
      assert.equal((yield* request("/", { method: "POST" })).status, 405);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "starkcode-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: "clerk.unconfigured.invalid",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("starkcode-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "starkcode-dev://app",
                  referer: "starkcode-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.unconfigured.invalid https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' blob: http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' starkcode-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' starkcode-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["starkcode-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["starkcode-dev"]]);
    }).pipe(Effect.provide(layerProtocol)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "starkcode",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("starkcode://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(layerProtocol)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "starkcode-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            clerkFrontendApiHostname: undefined,
          });
          const fiber = yield* Effect.forkChild(
            Effect.promise(() => handler!(new Request("starkcode-dev://app/"))),
          );
          yield* TestClock.adjust("50 millis");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(layerProtocol)),
  );

  it.effect("rejects with the last renderer target failure after 50ms and 150ms retries", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const lastFailure = new Error("connect ECONNREFUSED 127.0.0.1:5733 (3)");
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733 (1)"))
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733 (2)"))
        .mockRejectedValueOnce(lastFailure);

      const rejection = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "starkcode-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            clerkFrontendApiHostname: undefined,
          });
          const fiber = yield* Effect.forkChild(
            Effect.promise(() =>
              handler!(new Request("starkcode-dev://app/")).then(
                () => null,
                (error: unknown) => error,
              ),
            ),
          );
          yield* TestClock.adjust("49 millis");
          assert.equal(netFetchMock.mock.calls.length, 1);
          yield* TestClock.adjust("1 millis");
          assert.equal(netFetchMock.mock.calls.length, 2);
          yield* TestClock.adjust("149 millis");
          assert.equal(netFetchMock.mock.calls.length, 2);
          yield* TestClock.adjust("1 millis");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.strictEqual(rejection, lastFailure);
      assert.equal(netFetchMock.mock.calls.length, 3);
    }).pipe(Effect.provide(layerProtocol)),
  );

  it.effect("holds proxied requests past 64 in flight until earlier bodies settle", () =>
    Effect.gen(function* () {
      netFetchMock.mockImplementation(() => Promise.resolve(new Response("export {};")));
      const load = yield* registerDevProxy;

      // A cold module graph fans out faster than bodies are read.
      const pending = Array.from({ length: PROXY_SLOTS + 2 }, () => load());
      const inFlight = yield* Effect.promise(() => Promise.all(pending.slice(0, PROXY_SLOTS)));
      const queued = pending.slice(PROXY_SLOTS);
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS);

      // Reading a body to the end frees its slot for one queued request.
      assert.equal(yield* Effect.promise(() => inFlight[0]!.text()), "export {};");
      yield* Effect.promise(() => Promise.race(queued));
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS + 1);

      // So does the renderer cancelling a body.
      yield* Effect.promise(() => inFlight[1]!.body!.cancel());
      yield* Effect.promise(() => Promise.all(queued));
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS + 2);
    }).pipe(Effect.scoped, Effect.provide(layerProtocol)),
  );

  it.effect("returns the slot of a failed fetch, a failed body, or an empty response", () =>
    Effect.gen(function* () {
      netFetchMock.mockImplementation(() => Promise.resolve(new Response("export {};")));
      const load = yield* registerDevProxy;
      const inFlight = yield* fillSlots(load);
      // Each case below starts on a slot freed by reading a held body, so the
      // load after it can only start on the slot that case returned.

      const resetError = new Error("socket hang up");
      netFetchMock.mockRejectedValueOnce(resetError);
      const failedFetch = rejectionOf(load("/api/upload", { method: "POST", body: "{}" }));
      yield* Effect.promise(() => inFlight[0]!.text());
      assert.strictEqual(yield* Effect.promise(() => failedFetch), resetError);
      yield* Effect.promise(() => load());

      netFetchMock.mockResolvedValueOnce(
        new Response(
          new ReadableStream({ pull: (controller) => controller.error(new Error("reset")) }),
        ),
      );
      const failedBody = load();
      yield* Effect.promise(() => inFlight[1]!.text());
      const bodyError = yield* Effect.promise(() =>
        rejectionOf(failedBody.then((response) => response.text())),
      );
      assert.instanceOf(bodyError, Error);
      yield* Effect.promise(() => load());

      netFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const empty = load();
      yield* Effect.promise(() => inFlight[2]!.text());
      assert.equal((yield* Effect.promise(() => empty)).status, 204);
      yield* Effect.promise(() => load());
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS + 6);
    }).pipe(Effect.scoped, Effect.provide(layerProtocol)),
  );

  it.effect("drops an aborted request from the queue and aborts its upstream fetch", () =>
    Effect.gen(function* () {
      netFetchMock.mockImplementation(() => Promise.resolve(new Response("export {};")));
      const load = yield* registerDevProxy;
      const inFlight = yield* fillSlots(load);

      // Aborted while queued: it leaves the queue and never fetches.
      const queuedAbort = new AbortController();
      const queued = rejectionOf(load("/src/queued.ts", { signal: queuedAbort.signal }));
      queuedAbort.abort();
      yield* Effect.promise(() => inFlight[0]!.text());
      yield* Effect.promise(() => inFlight[1]!.text());
      yield* Effect.promise(() => load());
      assert.isNotNull(yield* Effect.promise(() => queued));
      assert.isFalse(
        netFetchMock.mock.calls.some(([url]) => String(url).endsWith("/src/queued.ts")),
      );

      // Aborted while fetching: the upstream fetch is aborted and its slot returned.
      let upstreamSignal: AbortSignal | undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        netFetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
          upstreamSignal = init.signal ?? undefined;
          resolve();
          return new Promise<never>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        });
      });
      const fetchingAbort = new AbortController();
      const fetching = rejectionOf(load("/src/fetching.ts", { signal: fetchingAbort.signal }));
      yield* Effect.promise(() => fetchStarted);
      fetchingAbort.abort();
      assert.isNotNull(yield* Effect.promise(() => fetching));
      assert.isTrue(upstreamSignal?.aborted);
      yield* Effect.promise(() => load());
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS + 3);
    }).pipe(Effect.scoped, Effect.provide(layerProtocol)),
  );

  it.effect("returns the slots of abandoned bodies after a 2 second lease", () =>
    Effect.gen(function* () {
      netFetchMock.mockImplementation(() => Promise.resolve(new Response("export {};")));
      const load = yield* registerDevProxy;
      // A reload abandons these bodies without reading or cancelling them.
      yield* fillSlots(load);
      const afterReload = load();

      yield* TestClock.adjust("1999 millis");
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS);
      yield* TestClock.adjust("1 millis");
      yield* Effect.promise(() => afterReload);
      assert.equal(netFetchMock.mock.calls.length, PROXY_SLOTS + 1);
    }).pipe(Effect.scoped, Effect.provide(layerProtocol)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "starkcode-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "starkcode-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "starkcode-dev".');
    }).pipe(Effect.provide(layerProtocol)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "starkcode",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "starkcode");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "starkcode".');
      }
    }).pipe(Effect.provide(layerProtocol)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "starkcode",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.unconfigured.invalid",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://clerk.unconfigured.invalid",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], [
      "'self'",
      "blob:",
      "http:",
      "https:",
      "ws:",
      "wss:",
    ]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "starkcode:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["media-src"], ["'self'", "starkcode:", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["frame-src"], ["'self'", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["font-src"], ["'self'", "starkcode:", "data:"]);
  });
});
