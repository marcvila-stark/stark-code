import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/http";

import {
  declaresMockFeedKind,
  makeCanaryRouteLayer,
  makeMockUpdateRouteLayer,
  matchFaultRule,
  type MockUpdateRouteOptions,
  parseFaultPlanJson,
  parseFaultRules,
  rewriteManifestForFault,
  WRONG_SHA512,
} from "./mock-update-server.ts";
import { parseUpdateManifest } from "./lib/update-manifest.ts";
import { symlinksSupported } from "@starkfuture/shared/testing/symlinks";

const ZIP_NAME = "Stark-Code-0.0.46-alpha.2-arm64.zip";
const ZIP_BYTES = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251));
const MOCK_MANIFEST = [
  "version: 0.0.46-alpha.2",
  "files:",
  `  - url: ${ZIP_NAME}`,
  "    sha512: cmVhbC1zaGE1MTItb2YtdGhlLXppcA==",
  "    size: 4096",
  `path: ${ZIP_NAME}`,
  "sha512: cmVhbC1zaGE1MTItb2YtdGhlLXppcA==",
  "starkFeedKind: mock",
  "releaseDate: '2026-10-30T12:00:00.000Z'",
  "",
].join("\n");
const CANARY = "http://canary.localhost:3124";

const withMockUpdateServer = <A, E, R>(
  rootRealPath: string,
  effect: Effect.Effect<A, E, R>,
  options?: MockUpdateRouteOptions,
) =>
  effect.pipe(
    Effect.provide(
      HttpRouter.serve(makeMockUpdateRouteLayer(rootRealPath, options), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    ),
  );

/** A feed root with the manifest, the ZIP and its blockmap, plus a request log path. */
const makeFeed = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mock-update-feed-" });
  const root = path.join(scratch, "feed");
  yield* fileSystem.makeDirectory(root);
  yield* fileSystem.writeFileString(path.join(root, "latest-mac.yml"), MOCK_MANIFEST);
  yield* fileSystem.writeFile(path.join(root, ZIP_NAME), ZIP_BYTES);
  yield* fileSystem.writeFileString(path.join(root, `${ZIP_NAME}.blockmap`), "blockmap");
  return {
    root: yield* fileSystem.realPath(root),
    log: path.join(scratch, "requests.jsonl"),
    scratch,
  };
});

const readLog = (logPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(logPath);
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });

const withoutRedirects = Effect.provideService(FetchHttpClient.RequestInit, {
  keepalive: false,
  redirect: "manual",
});

describe("fault plans", () => {
  it("parses inline rules and matches the first rule for a path", () => {
    const rules = parseFaultRules("latest-mac.yml=malformed-yaml, *.zip=truncate-once, *=slow");
    assert.equal(matchFaultRule(rules, "/latest-mac.yml")?.mode, "malformed-yaml");
    assert.equal(matchFaultRule(rules, ZIP_NAME)?.mode, "truncate-once");
    assert.equal(matchFaultRule(rules, `${ZIP_NAME}.blockmap`)?.mode, "slow");
  });

  it("rejects unknown modes and manifest rewrites aimed at an artifact", () => {
    assert.throws(() => parseFaultRules("*.zip=explode"), /not <path>=<mode>/);
    assert.throws(() => parseFaultRules("*.zip=wrong-sha512"), /must name a .yml file/);
    assert.throws(
      () => parseFaultPlanJson('{"faults":[{"path":"*.zip","mode":"slow","delayMs":-1}]}'),
      /non-negative integer/,
    );
  });

  it("recognises only manifests that declare the mock kind", () => {
    assert.isTrue(declaresMockFeedKind(MOCK_MANIFEST));
    assert.isTrue(declaresMockFeedKind("version: 1\nstarkFeedKind: 'mock'\n"));
    assert.isFalse(declaresMockFeedKind("version: 1\nstarkFeedKind: stark\n"));
    assert.isFalse(declaresMockFeedKind("version: 1\n"));
  });

  it("points every hostile rewrite away from the feed and keeps the rest intact", () => {
    const context = { canaryOrigin: CANARY };
    const absolute = rewriteManifestForFault(MOCK_MANIFEST, "hostile-absolute-url", context);
    assert.include(absolute, `  - url: ${CANARY}/hostile-absolute/${ZIP_NAME}`);
    assert.include(absolute, `path: ${CANARY}/hostile-absolute/${ZIP_NAME}`);
    assert.include(absolute, "starkFeedKind: mock");

    const protocolRelative = rewriteManifestForFault(
      MOCK_MANIFEST,
      "hostile-protocol-relative-url",
      context,
    );
    assert.include(
      protocolRelative,
      `  - url: //canary.localhost:3124/hostile-protocol-relative/${ZIP_NAME}`,
    );

    const traversal = rewriteManifestForFault(MOCK_MANIFEST, "hostile-traversal-url", context);
    assert.include(traversal, `  - url: ../hostile-traversal/${ZIP_NAME}`);

    const legacy = rewriteManifestForFault(MOCK_MANIFEST, "hostile-legacy-path", context);
    assert.notInclude(legacy, "files:");
    assert.include(legacy, `path: ${CANARY}/hostile-legacy/${ZIP_NAME}`);
    assert.include(legacy, "sha512: cmVhbC1zaGE1MTItb2YtdGhlLXppcA==");
  });
});

it.layer(NodeServices.layer)("mock-update-server over HTTP", (it) => {
  it.effect("serves a mock manifest and logs the request with redacted credentials", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/latest-mac.yml?noCache=1abc", {
            headers: { authorization: "Bearer secret-value", "x-probe": "1" },
          });
          assert.equal(response.status, 200);
          assert.equal(response.headers["content-type"], "text/yaml");
          assert.equal(yield* response.text, MOCK_MANIFEST);
        }),
        { requestLogPath: feed.log },
      );
      const [entry] = yield* readLog(feed.log);
      assert.equal(entry?.["server"], "feed");
      assert.equal(entry?.["path"], "/latest-mac.yml");
      assert.equal(entry?.["query"], "noCache=1abc");
      assert.equal(entry?.["outcome"], "served");
      assert.match(String(entry?.["ts"]), /^\d{4}-\d{2}-\d{2}T/);
      const headers = entry?.["headers"] as Record<string, string>;
      assert.equal(headers["authorization"], "[redacted]");
      assert.equal(headers["x-probe"], "1");
    }),
  );

  it.effect("refuses a manifest that does not declare the mock kind", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const feed = yield* makeFeed;
      yield* fileSystem.writeFileString(
        path.join(feed.root, "latest-mac.yml"),
        MOCK_MANIFEST.replace("starkFeedKind: mock\n", ""),
      );
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/latest-mac.yml");
          assert.equal(response.status, 403);
          assert.include(yield* response.text, "starkFeedKind: mock");
        }),
        { requestLogPath: feed.log },
      );
      const [entry] = yield* readLog(feed.log);
      assert.equal(entry?.["outcome"], "refused-not-mock");
    }),
  );

  it.effect("truncate-once drops the first download and serves the second in full", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const first = yield* client.get(`/${ZIP_NAME}`);
          assert.equal(first.status, 200);
          assert.equal(first.headers["content-length"], String(ZIP_BYTES.length));
          const firstBody = yield* Effect.result(first.arrayBuffer);
          if (firstBody._tag === "Success") {
            assert.isBelow(firstBody.success.byteLength, ZIP_BYTES.length);
          }
          const second = yield* client.get(`/${ZIP_NAME}`);
          assert.deepEqual(new Uint8Array(yield* second.arrayBuffer), ZIP_BYTES);
        }),
        { faults: parseFaultRules("*.zip=truncate-once"), requestLogPath: feed.log },
      );
      const outcomes = (yield* readLog(feed.log)).map((entry) => entry["outcome"]);
      assert.deepEqual(outcomes, ["truncated", "served-after-truncation"]);
    }),
  );

  it.effect("truncate-once also drops the first manifest download", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const first = yield* Effect.result((yield* client.get("/latest-mac.yml")).text);
          if (first._tag === "Success") assert.isBelow(first.success.length, MOCK_MANIFEST.length);
          const second = yield* client.get("/latest-mac.yml");
          assert.equal(second.headers["content-type"], "text/yaml");
          assert.equal(yield* second.text, MOCK_MANIFEST);
        }),
        { faults: parseFaultRules("latest-mac.yml=truncate-once") },
      );
    }),
  );

  it.effect("http-503 and not-found answer with their status even though the file exists", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const unavailable = yield* client.get("/latest-mac.yml");
          assert.equal(unavailable.status, 503);
          assert.equal(unavailable.headers["retry-after"], "1");
          const missing = yield* client.get(`/${ZIP_NAME}`);
          assert.equal(missing.status, 404);
        }),
        { faults: parseFaultRules("latest-mac.yml=http-503,*.zip=not-found") },
      );
    }),
  );

  it.effect("malformed-yaml serves a manifest no parser accepts", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/latest-mac.yml");
          assert.equal(response.status, 200);
          const body = yield* response.text;
          assert.throws(() => parseUpdateManifest(body, "latest-mac.yml", "macOS"));
        }),
        { faults: parseFaultRules("latest-mac.yml=malformed-yaml") },
      );
    }),
  );

  it.effect("wrong-sha512 keeps the file names and replaces every digest", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const body = yield* (yield* client.get("/latest-mac.yml")).text;
          const manifest = parseUpdateManifest(body, "latest-mac.yml", "macOS");
          assert.deepEqual(
            manifest.files.map((file) => [file.url, file.sha512]),
            [[ZIP_NAME, WRONG_SHA512]],
          );
          assert.notInclude(body, "cmVhbC1zaGE1MTItb2YtdGhlLXppcA==");
        }),
        { faults: parseFaultRules("latest-mac.yml=wrong-sha512") },
      );
    }),
  );

  it.effect("redirect modes send the client to the canary and log where", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const foreign = yield* withoutRedirects(client.get(`/${ZIP_NAME}`));
          assert.equal(foreign.status, 302);
          assert.equal(
            foreign.headers["location"],
            `${CANARY}/redirect-to-foreign-host/${ZIP_NAME}`,
          );
          const loopback = yield* withoutRedirects(client.get(`/${ZIP_NAME}.blockmap`));
          assert.equal(
            loopback.headers["location"],
            `http://127.0.0.1:3124/redirect-to-loopback/${ZIP_NAME}.blockmap`,
          );
        }),
        {
          faults: parseFaultRules("*.zip=redirect-to-foreign-host,*.blockmap=redirect-to-loopback"),
          canaryOrigin: CANARY,
          canaryLoopbackOrigin: "http://127.0.0.1:3124",
          requestLogPath: feed.log,
        },
      );
      const [entry] = yield* readLog(feed.log);
      assert.equal(entry?.["location"], `${CANARY}/redirect-to-foreign-host/${ZIP_NAME}`);
    }),
  );

  it.effect("hostile manifest modes are served over HTTP with the canary in every file URL", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const body = yield* (yield* client.get("/latest-mac.yml")).text;
          const fileUrls = [...body.matchAll(/^\s*- url:\s*'?(.+?)'?\s*$/gmu)].map(
            (match) => match[1],
          );
          assert.deepEqual(fileUrls, [`${CANARY}/hostile-absolute/${ZIP_NAME}`]);
          // The release tooling's own parser refuses it, like the app does.
          assert.throws(
            () => parseUpdateManifest(body, "latest-mac.yml", "macOS"),
            /not a plain name inside the feed/u,
          );
        }),
        {
          faults: parseFaultRules("latest-mac.yml=hostile-absolute-url"),
          canaryOrigin: CANARY,
        },
      );
    }),
  );

  it.effect("re-reads the fault plan file on every request", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const feed = yield* makeFeed;
      const planPath = path.join(feed.scratch, "faults.json");
      yield* fileSystem.writeFileString(
        planPath,
        '{"faults":[{"path":"*.zip","mode":"http-503"}]}',
      );
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          assert.equal((yield* client.get(`/${ZIP_NAME}`)).status, 503);
          yield* fileSystem.writeFileString(planPath, '{"faults":[]}');
          assert.equal((yield* client.get(`/${ZIP_NAME}`)).status, 200);
          yield* fileSystem.writeFileString(planPath, "{not json");
          assert.equal((yield* client.get(`/${ZIP_NAME}`)).status, 500);
        }),
        { faultsFile: planPath, requestLogPath: feed.log },
      );
      const outcomes = (yield* readLog(feed.log)).map((entry) => entry["outcome"]);
      assert.deepEqual(outcomes, ["fault", "served", "plan-invalid"]);
    }),
  );

  it.effect("serves only below the base path and logs requests outside it", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* withMockUpdateServer(
        feed.root,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          assert.equal((yield* client.get("/feed/latest-mac.yml")).status, 200);
          assert.equal((yield* client.get("/latest-mac.yml")).status, 404);
        }),
        { basePath: "/feed/", requestLogPath: feed.log },
      );
      const outcomes = (yield* readLog(feed.log)).map((entry) => entry["outcome"]);
      assert.deepEqual(outcomes, ["served", "outside-base-path"]);
    }),
  );

  it.effect("the canary answers 404 and records every hit as forbidden", () =>
    Effect.gen(function* () {
      const feed = yield* makeFeed;
      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(`/hostile-absolute/${ZIP_NAME}`);
        assert.equal(response.status, 404);
      }).pipe(
        Effect.provide(
          HttpRouter.serve(makeCanaryRouteLayer({ requestLogPath: feed.log }), {
            disableListenLog: true,
            disableLogger: true,
          }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      );
      const [entry] = yield* readLog(feed.log);
      assert.equal(entry?.["server"], "canary");
      assert.equal(entry?.["outcome"], "forbidden-hit");
      assert.equal(entry?.["path"], `/hostile-absolute/${ZIP_NAME}`);
    }),
  );

  it.effect("rejects encoded path traversal outside the configured root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-outside-",
      });
      const rootRealPath = yield* fileSystem.realPath(root);

      yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "nope\n");

      yield* withMockUpdateServer(
        rootRealPath,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/%2e%2e/secret.txt");

          assert.equal(response.status, 404);
          assert.equal(yield* response.text, "Not Found");
        }),
      );
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects symlinked files that escape the configured root",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "mock-update-server-root-",
        });
        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "mock-update-server-outside-",
        });
        const rootRealPath = yield* fileSystem.realPath(root);
        const outsideFile = path.join(outside, "outside.zip");
        const linksDir = path.join(root, "links");
        const symlinkPath = path.join(linksDir, "outside.zip");

        yield* fileSystem.writeFileString(outsideFile, "outside\n");
        yield* fileSystem.makeDirectory(linksDir, { recursive: true });
        yield* fileSystem.symlink(outsideFile, symlinkPath);

        yield* withMockUpdateServer(
          rootRealPath,
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const response = yield* client.get("/links/outside.zip");

            assert.equal(response.status, 404);
            assert.equal(yield* response.text, "Not Found");
          }),
        );
      }),
  );
});

it.live("slow streams the whole file in delayed chunks", () =>
  Effect.gen(function* () {
    const feed = yield* makeFeed;
    yield* withMockUpdateServer(
      feed.root,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const startedAt = yield* Clock.currentTimeMillis;
        const response = yield* client.get(`/${ZIP_NAME}`);
        assert.deepEqual(new Uint8Array(yield* response.arrayBuffer), ZIP_BYTES);
        // Four chunks, each preceded by a 20 ms pause.
        assert.isAtLeast((yield* Clock.currentTimeMillis) - startedAt, 60);
      }),
      {
        faults: parseFaultPlanJson(
          '{"faults":[{"path":"*.zip","mode":"slow","chunkBytes":1024,"delayMs":20}]}',
        ),
      },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
