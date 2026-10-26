// A real loopback HTTP server verifies the token header, response bound and lack of redirects.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as StarkPages from "./StarkPages.ts";

const scenario = (
  check: (fixture: {
    readonly pages: StarkPages.StarkPages["Service"];
    readonly root: string;
    readonly port: number;
    readonly opened: unknown[];
    readonly requests: NodeHttp.IncomingHttpHeaders[];
    readonly response: { status: number; root?: string; body?: string };
    readonly catalog: { status: number; body: string };
    readonly paths: string[];
    readonly writeDescriptor: (value: unknown) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-pages-" });
      yield* fs.makeDirectory(path.join(root, "pages", ".spage"), { recursive: true });
      const requests: NodeHttp.IncomingHttpHeaders[] = [];
      const opened: unknown[] = [];
      const response: { status: number; root?: string; body?: string } = { status: 200 };
      const catalog = { status: 200, body: "[]" };
      const paths: string[] = [];
      const server = NodeHttp.createServer((request, reply) => {
        requests.push(request.headers);
        paths.push(request.url ?? "");
        if (request.url === "/api/pages") {
          reply.writeHead(catalog.status, {
            "Content-Type": "application/json",
            Location: "/elsewhere",
          });
          reply.end(catalog.body);
          return;
        }
        reply.writeHead(response.status, {
          "Content-Type": "application/json",
          Location: "https://example.invalid/never-follow",
        });
        reply.end(
          response.body ??
            JSON.stringify({ ok: true, root: response.root ?? root, pid: process.pid }),
        );
      });
      const port = yield* Effect.tryPromise(async () => {
        for (let candidate = 4317; candidate <= 4337; candidate++) {
          const available = await new Promise<boolean>((resolve) => {
            const failed = () => {
              server.off("listening", ready);
              resolve(false);
            };
            const ready = () => {
              server.off("error", failed);
              resolve(true);
            };
            server.once("error", failed);
            server.once("listening", ready);
            server.listen(candidate, "127.0.0.1");
          });
          if (available) return candidate;
        }
        throw new Error("No free Stark Pages mirror test port.");
      }).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const writeDescriptor = (value: unknown) =>
        fs
          .writeFileString(path.join(root, "pages", ".spage", "mirror.json"), JSON.stringify(value))
          .pipe(Effect.orDie);
      yield* writeDescriptor({ port, token: "b".repeat(64), pid: process.pid, startedAt: "test" });
      const shell = ElectronShell.ElectronShell.of({
        openExternal: (url) =>
          Effect.sync(() => {
            opened.push(url);
            return true;
          }),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        yield* check({
          pages: yield* StarkPages.StarkPages,
          root,
          port,
          opened,
          requests,
          response,
          catalog,
          paths,
          writeDescriptor,
        });
      }).pipe(
        Effect.provide(
          StarkPages.layer({ kitRoot: "/missing/stark-workbench", nodePath: process.execPath }),
        ),
        Effect.provideService(ElectronShell.ElectronShell, shell),
      );
    }),
  );

// The service is provided inside each scenario after constructing its per-test shell.
const withScenario = (check: Parameters<typeof scenario>[0]) =>
  scenario(check).pipe(Effect.provide(NodeServices.layer));

it.live("finds a live project mirror without returning its token", () =>
  withScenario(({ pages, root, port, requests }) =>
    Effect.gen(function* () {
      const mirror = yield* pages.findMirror(root);
      expect(mirror).toEqual({ root, port });
      expect(JSON.stringify(mirror)).not.toContain("b".repeat(64));
      expect(requests[0]?.["x-spage-token"]).toBe("b".repeat(64));
      expect(requests[0]?.origin).toBeUndefined();
    }),
  ),
);

it.live("lists only validated document metadata without exposing extra mirror fields", () =>
  withScenario(({ pages, root, catalog, paths, requests }) =>
    Effect.gen(function* () {
      const page = {
        slug: "my-report",
        title: "My report",
        type: "report",
        status: "draft",
        mtime: "2026-10-23T12:00:00.000Z",
      };
      catalog.body = JSON.stringify([
        { ...page, token: "private", html: "secret" },
        { ...page, slug: "../outside" },
      ]);
      expect(yield* pages.listPages(root)).toEqual([page]);
      expect(paths).toEqual(["/health", "/api/pages"]);
      expect(requests[1]?.["x-spage-token"]).toBe("b".repeat(64));
      expect(requests[1]?.origin).toBeUndefined();
      catalog.body = "[]";
      expect(yield* pages.listPages(root)).toEqual([]);
    }),
  ),
);

it.live(
  "distinguishes a failed catalog from an empty library and never follows catalog redirects",
  () =>
    withScenario(({ pages, root, catalog, paths, response }) =>
      Effect.gen(function* () {
        catalog.status = 302;
        expect(yield* pages.listPages(root)).toBeNull();
        expect(paths).toEqual(["/health", "/api/pages"]);
        catalog.status = 200;
        catalog.body = "not-json";
        expect(yield* pages.listPages(root)).toBeNull();
        catalog.body = "x".repeat(2 * 1024 * 1024 + 1);
        expect(yield* pages.listPages(root)).toBeNull();
        const before = paths.length;
        response.root = root + "-wrong";
        expect(yield* pages.listPages(root)).toBeNull();
        expect(paths.slice(before)).toEqual(["/health"]);
      }),
    ),
);

it.live("refuses a stale or foreign mirror and follows no redirect", () =>
  withScenario(({ pages, root, requests, response }) =>
    Effect.gen(function* () {
      response.root = root + "-other";
      expect(yield* pages.findMirror(root)).toBeNull();
      response.root = root;
      response.status = 302;
      expect(yield* pages.findMirror(root)).toBeNull();
      expect(requests).toHaveLength(2);
      response.status = 200;
      response.body = "x".repeat(9000);
      expect(yield* pages.findMirror(root)).toBeNull();
    }),
  ),
);

it.live("opens only a validated follower and credential-free source links", () =>
  withScenario(({ pages, root, port, opened }) =>
    Effect.gen(function* () {
      const url = `http://127.0.0.1:${port}/follow?slug=decision-one`;
      expect(yield* pages.openFollow({ projectRoot: root, url })).toBe(true);
      expect(
        yield* pages.openFollow({
          projectRoot: root,
          url: `http://127.0.0.1:${port}@evil.example/follow?slug=decision-one`,
        }),
      ).toBe(false);
      expect(yield* pages.openLink("https://starkfuture.com/report")).toBe(true);
      expect(yield* pages.openLink("https://user:password@example.com/report")).toBe(false);
      expect(opened).toEqual([url, "https://starkfuture.com/report"]);
    }),
  ),
);

it.live("does not probe a malformed descriptor or port outside the mirror range", () =>
  withScenario(({ pages, root, requests, writeDescriptor }) =>
    Effect.gen(function* () {
      yield* writeDescriptor({ port: 8000, token: "b".repeat(64), pid: process.pid });
      expect(yield* pages.findMirror(root)).toBeNull();
      yield* writeDescriptor({ port: 4317, token: "bad", pid: process.pid });
      expect(yield* pages.findMirror(root)).toBeNull();
      expect(requests).toHaveLength(0);
    }),
  ),
);
