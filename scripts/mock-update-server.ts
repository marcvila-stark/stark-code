// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer takes `NodeHttp.createServer` as arg
import * as NodeHttp from "node:http";

import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { MANIFEST_FEED_KIND_KEY } from "./lib/update-release-seams.ts";

/**
 * Local update feed for packaged-update rehearsals. It serves a directory that
 * holds one `latest-mac.yml` plus the ZIP and blockmap it names, and can inject
 * one fault per request path so each rehearsal row exercises a specific
 * failure. Every request, including those to the canary, is appended to a
 * JSONL log. The mock feed is development evidence only: it never proves what
 * a Stark-hosted HTTPS feed does.
 */

export const MOCK_UPDATE_FAULT_MODES = [
  "none",
  "truncate-once",
  "http-503",
  "not-found",
  "malformed-yaml",
  "wrong-sha512",
  "redirect-to-foreign-host",
  "redirect-to-loopback",
  "slow",
  "hostile-absolute-url",
  "hostile-protocol-relative-url",
  "hostile-traversal-url",
  "hostile-legacy-path",
] as const;
export type MockUpdateFaultMode = (typeof MOCK_UPDATE_FAULT_MODES)[number];

/** Modes that rewrite a manifest; they make no sense for a ZIP or blockmap. */
const MANIFEST_ONLY_MODES: ReadonlySet<MockUpdateFaultMode> = new Set([
  "malformed-yaml",
  "wrong-sha512",
  "hostile-absolute-url",
  "hostile-protocol-relative-url",
  "hostile-traversal-url",
  "hostile-legacy-path",
]);

export interface MockUpdateFaultRule {
  /** `latest-mac.yml`, a suffix glob such as `*.zip`, or `*` for every path. */
  readonly pattern: string;
  readonly mode: MockUpdateFaultMode;
  /** `slow` only: bytes per chunk. */
  readonly chunkBytes?: number;
  /** `slow` only: pause before each chunk. */
  readonly delayMs?: number;
}

/** The top-level key a manifest must carry before the mock server serves it. */
export const MOCK_FEED_KIND_KEY = MANIFEST_FEED_KIND_KEY;
export const MOCK_FEED_KIND = "mock";

/** A syntactically valid sha512 that matches nothing the build produced. */
export const WRONG_SHA512 =
  "c3RhcmstbW9jay13cm9uZy1zaGE1MTItZG8tbm90LXRydXN0LXRoaXMtdmFsdWUtc3RhcmstbW9jay13cm9uZy1zaGE1MTI=";

const DEFAULT_SLOW_CHUNK_BYTES = 64 * 1024;
const DEFAULT_SLOW_DELAY_MS = 100;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie"]);

export class InvalidMockUpdateFaultPlanError extends Schema.TaggedError<InvalidMockUpdateFaultPlanError>()(
  "InvalidMockUpdateFaultPlanError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Invalid mock update fault plan: ${this.detail}`;
  }
}

export class NonLoopbackMockUpdateHostError extends Schema.TaggedError<NonLoopbackMockUpdateHostError>()(
  "NonLoopbackMockUpdateHostError",
  { host: Schema.String },
) {
  override get message(): string {
    return `The mock update server only binds a loopback address, not '${this.host}'.`;
  }
}

const isFaultPlanError = Schema.is(InvalidMockUpdateFaultPlanError);
const toFaultPlanError = (cause: unknown) =>
  isFaultPlanError(cause) ? cause : new InvalidMockUpdateFaultPlanError({ detail: String(cause) });

const isFaultMode = (value: string): value is MockUpdateFaultMode =>
  (MOCK_UPDATE_FAULT_MODES as ReadonlyArray<string>).includes(value);

export const isManifestPath = (relativePath: string) => /\.ya?ml$/i.test(relativePath);

function validateRule(rule: MockUpdateFaultRule): MockUpdateFaultRule {
  if (rule.pattern.length === 0) {
    throw new InvalidMockUpdateFaultPlanError({ detail: "a rule has an empty path pattern" });
  }
  if (MANIFEST_ONLY_MODES.has(rule.mode) && !isManifestPath(rule.pattern)) {
    throw new InvalidMockUpdateFaultPlanError({
      detail: `'${rule.mode}' rewrites a manifest, so its pattern must name a .yml file, not '${rule.pattern}'`,
    });
  }
  for (const key of ["chunkBytes", "delayMs"] as const) {
    const value = rule[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < (key === "chunkBytes" ? 1 : 0))
    ) {
      throw new InvalidMockUpdateFaultPlanError({
        detail: `'${key}' must be a ${key === "chunkBytes" ? "positive" : "non-negative"} integer`,
      });
    }
  }
  return rule;
}

/** Parses `latest-mac.yml=malformed-yaml,*.zip=truncate-once`. */
export function parseFaultRules(spec: string): ReadonlyArray<MockUpdateFaultRule> {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.lastIndexOf("=");
      const pattern = entry.slice(0, separator).trim();
      const mode = entry.slice(separator + 1).trim();
      if (separator <= 0 || !isFaultMode(mode)) {
        throw new InvalidMockUpdateFaultPlanError({
          detail: `'${entry}' is not <path>=<mode>; modes are ${MOCK_UPDATE_FAULT_MODES.join(", ")}`,
        });
      }
      return validateRule({ pattern, mode });
    });
}

const FaultPlanFile = Schema.Struct({
  faults: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.Literals(MOCK_UPDATE_FAULT_MODES),
      chunkBytes: Schema.optionalKey(Schema.Number),
      delayMs: Schema.optionalKey(Schema.Number),
    }),
  ),
});
const decodeFaultPlanFile = Schema.decodeUnknownSync(Schema.fromJsonString(FaultPlanFile));

/** Parses `{"faults":[{"path":"*.zip","mode":"slow","delayMs":50}]}`. */
export function parseFaultPlanJson(raw: string): ReadonlyArray<MockUpdateFaultRule> {
  let decoded: typeof FaultPlanFile.Type;
  try {
    decoded = decodeFaultPlanFile(raw);
  } catch (cause) {
    throw new InvalidMockUpdateFaultPlanError({ detail: String(cause) });
  }
  return decoded.faults.map(({ path, ...rest }) => validateRule({ pattern: path, ...rest }));
}

/** The first rule whose pattern matches wins. */
export function matchFaultRule(
  rules: ReadonlyArray<MockUpdateFaultRule>,
  relativePath: string,
): MockUpdateFaultRule | undefined {
  const name = relativePath.replace(/^\/+/, "");
  return rules.find((rule) =>
    rule.pattern === "*"
      ? true
      : rule.pattern.startsWith("*")
        ? name.endsWith(rule.pattern.slice(1))
        : name === rule.pattern.replace(/^\/+/, ""),
  );
}

export function declaresMockFeedKind(manifest: string): boolean {
  return new RegExp(`^${MOCK_FEED_KIND_KEY}:\\s*'?${MOCK_FEED_KIND}'?\\s*$`, "m").test(manifest);
}

export interface ManifestRewriteContext {
  /** Origin of the canary server that stands in for any foreign host. */
  readonly canaryOrigin: string;
}

const fileUrlLine = /^( {2}- url:\s*)(.+?)\s*$/;
const unquote = (value: string) =>
  value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;

/**
 * Rewrites a manifest for one fault. The edits are line-based so everything
 * the fault does not target stays exactly as electron-builder wrote it.
 */
export function rewriteManifestForFault(
  manifest: string,
  mode: MockUpdateFaultMode,
  context: ManifestRewriteContext,
): string {
  const lines = manifest.split("\n");
  const rewriteUrls = (rewrite: (name: string) => string) =>
    lines
      .map((line) => {
        const urlMatch = line.match(fileUrlLine);
        if (urlMatch?.[1] && urlMatch[2]) return `${urlMatch[1]}${rewrite(unquote(urlMatch[2]))}`;
        const pathMatch = line.match(/^path:\s*(.+?)\s*$/);
        if (pathMatch?.[1]) return `path: ${rewrite(unquote(pathMatch[1]))}`;
        return line;
      })
      .join("\n");
  const canary = context.canaryOrigin.replace(/\/+$/, "");
  const canaryHost = canary.replace(/^[a-z]+:/i, "");

  switch (mode) {
    case "malformed-yaml":
      return "version: [unterminated\nfiles: {{{ this is not yaml\n";
    case "wrong-sha512":
      return lines
        .map((line) => line.replace(/^(\s*(?:- )?sha512:\s*).+$/, `$1${WRONG_SHA512}`))
        .join("\n");
    case "hostile-absolute-url":
      return rewriteUrls((name) => `${canary}/hostile-absolute/${name}`);
    case "hostile-protocol-relative-url":
      return rewriteUrls((name) => `${canaryHost}/hostile-protocol-relative/${name}`);
    case "hostile-traversal-url":
      return rewriteUrls((name) => `../hostile-traversal/${name}`);
    case "hostile-legacy-path": {
      // Drop `files:` so electron-updater falls back to the legacy top-level
      // `path`, and point that at the canary.
      const firstFile = lines.map((line) => line.match(fileUrlLine)?.[2]).find(Boolean);
      const firstSha = lines.map((line) => line.match(/^ {4}sha512:\s*(.+)$/)?.[1]).find(Boolean);
      const kept: string[] = [];
      let inFiles = false;
      for (const line of lines) {
        if (line === "files:") {
          inFiles = true;
          continue;
        }
        if (inFiles && line.startsWith(" ")) continue;
        inFiles = false;
        if (/^(path|sha512):/.test(line)) continue;
        kept.push(line);
      }
      const name = unquote(firstFile ?? "update.zip");
      kept.splice(
        1,
        0,
        `path: ${canary}/hostile-legacy/${name}`,
        `sha512: ${firstSha ?? WRONG_SHA512}`,
      );
      return kept.join("\n");
    }
    default:
      return manifest;
  }
}

export function redactRequestHeaders(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    redacted[lower] = SENSITIVE_HEADERS.has(lower)
      ? "[redacted]"
      : typeof value === "string"
        ? value
        : value.join(", ");
  }
  return redacted;
}

export interface MockUpdateRouteOptions {
  /** Rules given at start-up. */
  readonly faults?: ReadonlyArray<MockUpdateFaultRule>;
  /** JSON fault plan re-read on every request, so rows can switch without a restart. */
  readonly faultsFile?: string;
  /** JSONL request log; omitted means no log. */
  readonly requestLogPath?: string;
  /** URL path the feed is mounted under, for example `/feed/`. */
  readonly basePath?: string;
  /** Origin of the canary, standing in for a foreign host. */
  readonly canaryOrigin?: string;
  /** Origin of the canary reached through a loopback address. */
  readonly canaryLoopbackOrigin?: string;
}

interface RequestLogEntry {
  readonly server: "feed" | "canary";
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly fault: MockUpdateFaultMode | "plan-invalid";
  readonly status: number;
  readonly bytes: number;
  readonly outcome: string;
  readonly location?: string;
}

const encodeLogLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const appendRequestLog = (logPath: string | undefined, entry: RequestLogEntry) =>
  Effect.gen(function* () {
    if (logPath === undefined) return;
    const fileSystem = yield* FileSystem.FileSystem;
    const ts = DateTime.formatIso(yield* DateTime.now);
    yield* fileSystem.writeFileString(logPath, `${encodeLogLine({ ts, ...entry })}\n`, {
      flag: "a",
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.logError(`Could not append the request log: ${cause}`)),
  );

const isOutsideRoot = (rootRealPath: string, filePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const relativePath = path.relative(rootRealPath, filePath);
    return (
      relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")
    );
  });

const isWithinRoot = (rootRealPath: string, filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const resolvedFilePath = yield* fileSystem.realPath(filePath).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (resolvedPath) => resolvedPath,
      }),
    );

    return (
      resolvedFilePath !== undefined && !(yield* isOutsideRoot(rootRealPath, resolvedFilePath))
    );
  });

const decodePath = (rawPath: string) =>
  Effect.try({
    try: () => decodeURIComponent(rawPath),
    catch: () => null,
  }).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: (value) => value,
    }),
  );

const resolveRequestedFilePath = (rootRealPath: string, decodedPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (decodedPath.includes("\0")) {
      return undefined;
    }

    const filePath = path.resolve(
      rootRealPath,
      `.${decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`}`,
    );

    return (yield* isOutsideRoot(rootRealPath, filePath)) ? undefined : filePath;
  });

const isServableFile = (rootRealPath: string, filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(filePath).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (info) => info,
      }),
    );

    if (stat?.type !== "File") {
      return false;
    }

    return yield* isWithinRoot(rootRealPath, filePath);
  });

const normalizeBasePath = (basePath: string | undefined) => {
  const trimmed = (basePath ?? "/").trim();
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
};

const chunkBytes = (bytes: Uint8Array, size: number): ReadonlyArray<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
};

export const makeMockUpdateRouteLayer = (
  rootRealPath: string,
  options: MockUpdateRouteOptions = {},
) => {
  const basePath = normalizeBasePath(options.basePath);
  const canaryOrigin = options.canaryOrigin ?? "http://canary.localhost:3001";
  const canaryLoopbackOrigin = options.canaryLoopbackOrigin ?? "http://127.0.0.1:3001";
  // Paths already truncated once, keyed by the plan revision so editing the
  // plan file re-arms the fault.
  const truncated = new Set<string>();

  const loadRules = Effect.gen(function* () {
    if (options.faultsFile === undefined) {
      return { rules: options.faults ?? [], revision: "static" };
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(options.faultsFile);
    const fromFile = yield* Effect.try({
      try: () => parseFaultPlanJson(raw),
      catch: toFaultPlanError,
    });
    return { rules: [...fromFile, ...(options.faults ?? [])], revision: raw };
  });

  return HttpRouter.add(
    "*",
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const fileSystem = yield* FileSystem.FileSystem;
      const [rawPath = "/", query = ""] = (request.url ?? "/").split("?", 2);
      const base = {
        server: "feed" as const,
        method: request.method,
        path: rawPath,
        query,
        headers: redactRequestHeaders(request.headers),
      };
      const respond = (
        response: HttpServerResponse.HttpServerResponse,
        entry: Pick<RequestLogEntry, "fault" | "outcome" | "bytes"> & {
          readonly location?: string;
        },
      ) =>
        Effect.as(
          appendRequestLog(options.requestLogPath, { ...base, ...entry, status: response.status }),
          response,
        );

      const plan = yield* loadRules.pipe(Effect.result);
      if (plan._tag === "Failure") {
        yield* Effect.logError(`The fault plan could not be read: ${plan.failure}`);
        return yield* respond(HttpServerResponse.text("Fault plan invalid", { status: 500 }), {
          fault: "plan-invalid",
          outcome: "plan-invalid",
          bytes: 0,
        });
      }

      const decodedPath = yield* decodePath(rawPath);
      if (decodedPath === undefined || !decodedPath.startsWith(basePath)) {
        return yield* respond(HttpServerResponse.text("Not Found", { status: 404 }), {
          fault: "none",
          outcome: decodedPath === undefined ? "undecodable-path" : "outside-base-path",
          bytes: 0,
        });
      }
      const relativePath = decodedPath.slice(basePath.length);
      const rule = matchFaultRule(plan.success.rules, relativePath);
      const mode = rule?.mode ?? "none";

      if (mode === "http-503") {
        return yield* respond(
          HttpServerResponse.text("Service Unavailable", {
            status: 503,
            headers: { "retry-after": "1" },
          }),
          { fault: mode, outcome: "fault", bytes: 0 },
        );
      }
      if (mode === "not-found") {
        return yield* respond(HttpServerResponse.text("Not Found", { status: 404 }), {
          fault: mode,
          outcome: "fault",
          bytes: 0,
        });
      }
      if (mode === "redirect-to-foreign-host" || mode === "redirect-to-loopback") {
        const origin = mode === "redirect-to-foreign-host" ? canaryOrigin : canaryLoopbackOrigin;
        const location = `${origin.replace(/\/+$/, "")}/${mode}/${relativePath}`;
        return yield* respond(HttpServerResponse.redirect(location, { status: 302 }), {
          fault: mode,
          outcome: "fault",
          bytes: 0,
          location,
        });
      }

      const filePath = yield* resolveRequestedFilePath(rootRealPath, relativePath);
      if (!filePath || !(yield* isServableFile(rootRealPath, filePath))) {
        yield* Effect.logWarning(`Refused a path outside the root or not a file: ${rawPath}`);
        return yield* respond(HttpServerResponse.text("Not Found", { status: 404 }), {
          fault: mode,
          outcome: "not-servable",
          bytes: 0,
        });
      }

      // A manifest is rewritten for its fault first; truncation and slowness
      // then apply to whatever body is being sent, manifest or artifact.
      let manifestBody: Uint8Array | undefined;
      if (isManifestPath(relativePath)) {
        const manifest = yield* fileSystem.readFileString(filePath);
        // Only a manifest built for the mock feed may be served, so pointing
        // this server at a real release directory cannot hand a rehearsal app
        // (or anything else on this machine) a production update.
        if (!declaresMockFeedKind(manifest)) {
          return yield* respond(
            HttpServerResponse.text(
              `Refusing to serve a manifest that does not declare ${MOCK_FEED_KIND_KEY}: ${MOCK_FEED_KIND}.`,
              { status: 403 },
            ),
            { fault: mode, outcome: "refused-not-mock", bytes: 0 },
          );
        }
        manifestBody = new TextEncoder().encode(
          rewriteManifestForFault(manifest, mode, { canaryOrigin }),
        );
      }
      const contentType = manifestBody === undefined ? "application/octet-stream" : "text/yaml";

      if (mode === "truncate-once") {
        const key = `${plan.success.revision}\u0000${relativePath}`;
        if (!truncated.has(key)) {
          truncated.add(key);
          const bytes = manifestBody ?? (yield* fileSystem.readFile(filePath));
          const half = bytes.subarray(0, Math.floor(bytes.length / 2));
          // The full length is announced and the connection closes after half
          // the body, which is what a dropped download looks like to a client.
          return yield* respond(
            HttpServerResponse.stream(Stream.make(half), {
              contentLength: bytes.length,
              contentType,
              headers: { connection: "close" },
            }),
            { fault: mode, outcome: "truncated", bytes: half.length },
          );
        }
      }

      if (mode === "slow") {
        const bytes = manifestBody ?? (yield* fileSystem.readFile(filePath));
        const delayMs = rule?.delayMs ?? DEFAULT_SLOW_DELAY_MS;
        const chunks = chunkBytes(bytes, rule?.chunkBytes ?? DEFAULT_SLOW_CHUNK_BYTES);
        return yield* respond(
          HttpServerResponse.stream(
            Stream.fromIterable(chunks).pipe(
              Stream.mapEffect((chunk) => Effect.as(Effect.sleep(delayMs), chunk)),
            ),
            { contentLength: bytes.length, contentType },
          ),
          { fault: mode, outcome: "slow", bytes: bytes.length },
        );
      }

      const outcome =
        mode === "truncate-once" ? "served-after-truncation" : mode === "none" ? "served" : "fault";
      if (manifestBody !== undefined) {
        return yield* respond(
          HttpServerResponse.uint8Array(manifestBody, { contentType: "text/yaml" }),
          { fault: mode, outcome, bytes: manifestBody.length },
        );
      }
      const stat = yield* fileSystem.stat(filePath);
      return yield* respond(yield* HttpServerResponse.file(filePath, { status: 200 }), {
        fault: mode,
        outcome,
        bytes: Number(stat.size),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Unhandled mock update request failure: ${cause}`);
          return HttpServerResponse.text("Internal Server Error", { status: 500 });
        }),
      ),
    ),
  );
};

/**
 * Stands in for every host the app must never reach. Any request that lands
 * here is a forbidden hit: the log line is the evidence.
 */
export const makeCanaryRouteLayer = (options: { readonly requestLogPath?: string } = {}) =>
  HttpRouter.add(
    "*",
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const [rawPath = "/", query = ""] = (request.url ?? "/").split("?", 2);
      yield* Effect.logWarning(`Canary hit: ${request.method} ${rawPath}`);
      yield* appendRequestLog(options.requestLogPath, {
        server: "canary",
        method: request.method,
        path: rawPath,
        query,
        headers: redactRequestHeaders(request.headers),
        fault: "none",
        status: 404,
        bytes: 0,
        outcome: "forbidden-hit",
      });
      return HttpServerResponse.text("canary", { status: 404 });
    }),
  );

interface MockUpdateServerConfig {
  readonly host: string;
  readonly port: number;
  readonly canaryPort: number;
  readonly canaryHost: string;
  readonly rootRealPath: string;
  readonly routeOptions: MockUpdateRouteOptions;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const resolveMockUpdateServerConfig = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.all({
    host: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_HOST").pipe(
      Config.withDefault("127.0.0.1"),
    ),
    port: Config.Port("STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.withDefault(3000)),
    root: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT").pipe(
      Config.withDefault("../release-mock"),
    ),
    basePath: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_BASE_PATH").pipe(
      Config.withDefault("/"),
    ),
    faults: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_FAULTS").pipe(Config.withDefault("")),
    faultsFile: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_FAULTS_FILE").pipe(Config.option),
    requestLog: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_REQUEST_LOG").pipe(Config.option),
    canaryPort: Config.Port("STARK_CODE_DESKTOP_MOCK_UPDATE_CANARY_PORT").pipe(Config.option),
    canaryHost: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_CANARY_HOST").pipe(
      Config.withDefault("canary.localhost"),
    ),
  });
  if (!LOOPBACK_HOSTS.has(config.host)) {
    return yield* new NonLoopbackMockUpdateHostError({ host: config.host });
  }

  const rootRealPath = yield* fileSystem.realPath(path.resolve(import.meta.dirname, config.root));
  const canaryPort = Option.getOrElse(config.canaryPort, () => config.port + 1);
  const faults = yield* Effect.try({
    try: () => parseFaultRules(config.faults),
    catch: toFaultPlanError,
  });
  return {
    host: config.host,
    port: config.port,
    canaryPort,
    canaryHost: config.canaryHost,
    rootRealPath,
    routeOptions: {
      faults,
      basePath: config.basePath,
      canaryOrigin: `http://${config.canaryHost}:${canaryPort}`,
      canaryLoopbackOrigin: `http://127.0.0.1:${canaryPort}`,
      requestLogPath: Option.match(config.requestLog, {
        onNone: () => path.join(path.dirname(rootRealPath), "mock-update-requests.jsonl"),
        onSome: (value) => path.resolve(value),
      }),
      ...Option.match(config.faultsFile, {
        onNone: () => ({}),
        onSome: (value) => ({ faultsFile: path.resolve(value) }),
      }),
    },
  } satisfies MockUpdateServerConfig;
});

const makeMockUpdateServerLayer = (config: MockUpdateServerConfig) =>
  Layer.mergeAll(
    HttpRouter.serve(makeMockUpdateRouteLayer(config.rootRealPath, config.routeOptions)).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, { host: config.host, port: config.port }),
      ),
    ),
    HttpRouter.serve(
      makeCanaryRouteLayer(
        config.routeOptions.requestLogPath === undefined
          ? {}
          : { requestLogPath: config.routeOptions.requestLogPath },
      ),
    ).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: config.canaryPort }),
      ),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));

if (import.meta.main) {
  resolveMockUpdateServerConfig.pipe(
    Effect.tap((config) =>
      Effect.log(
        `Mock update feed on http://${config.host}:${config.port}${normalizeBasePath(config.routeOptions.basePath)} serving ${config.rootRealPath}; canary on ${config.routeOptions.canaryOrigin}; log ${config.routeOptions.requestLogPath}`,
      ),
    ),
    Effect.map(makeMockUpdateServerLayer),
    Layer.unwrap,
    Layer.launch,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
