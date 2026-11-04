/**
 * What the updater may contact, and the one decision the updater asks for
 * before it configures anything (`resolveDesktopUpdateFeed`).
 *
 * The ownership rules themselves (feed URLs, app-update.yml, baked policy,
 * signatures) live in scripts/lib/update-feed-ownership.ts so the desktop
 * build verifies a package with the same code that later accepts or refuses
 * it; they are re-exported here. Only a validated feed can reach
 * electron-updater, and `installUpdateRequestGuard` then checks every request
 * it sends, redirects included.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  STARK_UPDATE_OWNERSHIP,
  UPDATE_MANIFEST_FEED_KIND_KEY,
  checkOwnSignature,
  checkUpdateFileUrl,
  isSafeUpdatePathSegment,
  macChannelFileName,
  parseCodeSignatureSummary,
  readBakedUpdatePolicy,
  validateStarkUpdateFeed,
  type UpdateOwnership,
  type ValidatedStarkUpdateFeed,
} from "../../../../scripts/lib/update-feed-ownership.ts";

export * from "../../../../scripts/lib/update-feed-ownership.ts";

/**
 * Owner switch: block-map (differential) downloads stay off, so an update is
 * always one full ZIP from the feed. The request policy still covers block
 * maps and ranges should this change.
 */
export const DIFFERENTIAL_UPDATE_DOWNLOADS_ENABLED = false;

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Request-time policy

const UPDATE_REQUEST_REFUSALS = [
  "no-feed",
  "invalid-url",
  "host-override",
  "scheme",
  "credentials",
  "origin",
  "path",
  "query",
] as const;
export type UpdateRequestRefusal = (typeof UPDATE_REQUEST_REFUSALS)[number];

const NO_CACHE_QUERY = /^\?noCache=[0-9a-v]{1,32}$/u;

/**
 * Whether the updater may send a request to `url`: the feed's own scheme and
 * origin, a path below the feed directory made of plain segments, and a query
 * only on the channel manifest (electron-updater's `noCache=` cache buster).
 * Every hop of a redirect chain is checked the same way.
 */
export function evaluateUpdateRequest(
  url: string,
  feed: ValidatedStarkUpdateFeed,
): UpdateRequestRefusal | null {
  const parsed = parseUrl(url);
  if (parsed === undefined) return "invalid-url";
  if (parsed.protocol !== feed.location.protocol) return "scheme";
  if (parsed.username !== "" || parsed.password !== "") return "credentials";
  if (parsed.origin !== feed.location.origin) return "origin";
  if (parsed.hash !== "") return "query";
  const { basePath } = feed.location;
  if (!parsed.pathname.startsWith(basePath)) return "path";
  const relative = parsed.pathname.slice(basePath.length);
  if (relative === "" || relative.split("/").some((segment) => !isSafeUpdatePathSegment(segment))) {
    return "path";
  }
  if (parsed.search !== "") {
    const isChannelFile = feed.channels.some((channel) => relative === macChannelFileName(channel));
    if (!isChannelFile || !NO_CACHE_QUERY.test(parsed.search)) return "query";
  }
  return null;
}

const SQUIRREL_HANDOFF_FEED = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;

/**
 * electron-updater hands Squirrel.Mac the ZIP it already downloaded through a
 * one-shot server on `http://127.0.0.1:<ephemeral port>`. That is the only
 * feed URL the native updater may ever be given.
 */
export function isSquirrelHandoffFeedUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const port = SQUIRREL_HANDOFF_FEED.exec(url)?.[1];
  return port !== undefined && Number(port) <= 65_535;
}

const UPDATE_INFO_PROBLEMS = [
  "not-an-object",
  "version",
  "files",
  "file-url",
  "file-destination",
  "file-digest",
  "legacy-path",
  "packages",
  "release-notes",
  "feed-kind",
] as const;
export type UpdateInfoProblem = (typeof UPDATE_INFO_PROBLEMS)[number];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a parsed channel manifest before anything is downloaded from it:
 * every file (and the legacy `path`, which electron-builder still writes)
 * must be a plain relative name that resolves inside the feed directory.
 */
export function checkUpdateInfo(
  info: unknown,
  feed: ValidatedStarkUpdateFeed,
): UpdateInfoProblem | null {
  if (!isRecord(info)) return "not-an-object";
  if (typeof info.version !== "string" || info.version.length === 0) return "version";
  const files = info.files;
  if (!Array.isArray(files) || files.length === 0) return "files";
  const fileUrls: string[] = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.url !== "string") return "files";
    if (checkUpdateFileUrl(file.url) !== null) return "file-url";
    if (evaluateUpdateRequest(new URL(file.url, feed.location.href).href, feed) !== null) {
      return "file-destination";
    }
    if (typeof file.sha512 !== "string" || file.sha512.length === 0) return "file-digest";
    fileUrls.push(file.url);
  }
  if (info.path !== undefined && (typeof info.path !== "string" || !fileUrls.includes(info.path))) {
    return "legacy-path";
  }
  if (info.packages !== undefined && info.packages !== null) return "packages";
  const notes = info.releaseNotes;
  if (notes !== undefined && notes !== null && typeof notes !== "string" && !Array.isArray(notes)) {
    return "release-notes";
  }
  // A mock build follows only manifests made for a mock feed; a Stark build
  // never follows one.
  const manifestKind = info[UPDATE_MANIFEST_FEED_KIND_KEY];
  if (feed.kind === "mock" ? manifestKind !== "mock" : manifestKind !== undefined) {
    return "feed-kind";
  }
  return null;
}

export class StarkUpdateFeedInvalidError extends Schema.TaggedError<StarkUpdateFeedInvalidError>()(
  "StarkUpdateFeedInvalidError",
  { problem: Schema.Literals(UPDATE_INFO_PROBLEMS) },
) {
  /** Read by the updater's error classification, like electron-updater's own codes. */
  get code(): string {
    return "ERR_STARK_UPDATE_FEED_INVALID";
  }

  override get message(): string {
    return `The update feed returned a release Stark Code will not download (${this.problem}).`;
  }
}

export class StarkUpdateRequestRefusedError extends Schema.TaggedError<StarkUpdateRequestRefusedError>()(
  "StarkUpdateRequestRefusedError",
  {
    reason: Schema.Literals(UPDATE_REQUEST_REFUSALS),
    destination: Schema.String,
    redirect: Schema.Boolean,
  },
) {
  get code(): string {
    return "ERR_STARK_UPDATE_REQUEST_REFUSED";
  }

  override get message(): string {
    return `Refused an update ${this.redirect ? "redirect" : "request"} to ${this.destination} (${this.reason}).`;
  }
}

/** A URL for logs: origin and path, never the query. */
function describeDestination(url: string): string {
  const parsed = parseUrl(url);
  return parsed === undefined ? "an invalid URL" : `${parsed.origin}${parsed.pathname}`;
}

export interface UpdateRequestDecision {
  readonly kind: "request" | "redirect" | "native-feed" | "session";
  readonly destination: string;
  readonly refusal: UpdateRequestRefusal | null;
}

interface RequestOptionsLike {
  readonly url?: unknown;
  readonly host?: unknown;
  readonly auth?: unknown;
  readonly protocol?: unknown;
  readonly hostname?: unknown;
  readonly port?: unknown;
  readonly path?: unknown;
  readonly headers?: unknown;
}

/**
 * Rebuilds the URL a request-options object addresses the way Electron's
 * `net.request` would. Options that could let a header or field override the
 * destination (`url`, `host`, `auth` or a `Host` header) are refused outright:
 * electron-updater never sets them.
 */
function requestTargetOf(options: RequestOptionsLike): string | "host-override" | undefined {
  const headers = isRecord(options.headers) ? Object.keys(options.headers) : [];
  if (
    options.url !== undefined ||
    options.host !== undefined ||
    options.auth !== undefined ||
    headers.some((header) => header.toLowerCase() === "host")
  ) {
    return "host-override";
  }
  if (
    typeof options.protocol !== "string" ||
    typeof options.hostname !== "string" ||
    typeof options.path !== "string"
  ) {
    return undefined;
  }
  const port =
    typeof options.port === "string" || typeof options.port === "number"
      ? `:${String(options.port)}`
      : "";
  return `${options.protocol}//${options.hostname}${port}${options.path}`;
}

interface EmitterLike {
  on(event: string, listener: (...args: Array<any>) => void): unknown;
  emit(event: string, ...args: Array<unknown>): boolean;
  listenerCount(event: string): number;
}

interface ClientRequestLike extends EmitterLike {
  abort(): void;
  followRedirect?: () => void;
}

/** What `HttpExecutor.createRequest` returns for a refused request: it never touches the network. */
class RefusedUpdateRequest {
  private readonly listeners = new Map<string, Array<(...args: Array<any>) => void>>();
  private readonly error: StarkUpdateRequestRefusedError;
  private settled = false;

  constructor(error: StarkUpdateRequestRefusedError) {
    this.error = error;
  }

  on(event: string, listener: (...args: Array<any>) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: (...args: Array<any>) => void): this {
    return this.on(event, listener);
  }

  removeListener(event: string, listener: (...args: Array<any>) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
    );
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  emit(event: string, ...args: Array<unknown>): boolean {
    const listeners = this.listeners.get(event) ?? [];
    for (const listener of listeners) listener(...args);
    return listeners.length > 0;
  }

  setHeader(): void {}
  write(): boolean {
    return false;
  }
  followRedirect(): void {}
  abort(): void {
    this.settled = true;
  }

  end(): void {
    // Callers attach their error handler before `end()`; report on the next
    // tick so the rejection reaches it.
    process.nextTick(() => {
      if (this.settled) return;
      this.settled = true;
      this.emit("error", this.error);
    });
  }
}

interface HttpExecutorLike {
  createRequest(options: any, callback: (response: any) => void): any;
}

interface NativeUpdaterLike {
  setFeedURL(options: any): void;
}

interface SessionLike {
  readonly webRequest: {
    onBeforeRequest(
      listener: (
        details: { readonly url: string },
        callback: (response: { readonly cancel: boolean }) => void,
      ) => void,
    ): void;
  };
}

const GUARDED = Symbol.for("starkcode.updateRequestGuard");

/**
 * Wraps electron-updater's network boundary so every request is checked when
 * it is sent:
 *
 * - `executor.createRequest`, which every manifest, artifact, block map,
 *   range and fallback request goes through, refuses a forbidden
 *   destination before a request object exists;
 * - each allowed request's `redirect` event checks the next hop and aborts a
 *   forbidden one, so neither electron-updater's re-request nor a
 *   `followRedirect()` (the differential downloader's path) reaches it;
 * - the native Squirrel.Mac updater only ever accepts its 127.0.0.1 handoff;
 * - the `electron-updater` session cancels anything else as a backstop.
 *
 * `currentFeed` is read per request, so with no validated feed every request
 * is refused. Installing twice is a no-op.
 */
export function installUpdateRequestGuard(input: {
  readonly executor: HttpExecutorLike | null | undefined;
  readonly nativeUpdater?: NativeUpdaterLike | undefined;
  readonly session?: SessionLike | undefined;
  readonly currentFeed: () => ValidatedStarkUpdateFeed | undefined;
  readonly onDecision?: (decision: UpdateRequestDecision) => void;
  readonly onNativeRefused?: (error: StarkUpdateRequestRefusedError) => void;
}): void {
  const decide = (
    kind: UpdateRequestDecision["kind"],
    url: string,
    preset?: UpdateRequestRefusal,
  ): UpdateRequestRefusal | null => {
    const feed = input.currentFeed();
    const refusal = preset ?? (feed === undefined ? "no-feed" : evaluateUpdateRequest(url, feed));
    input.onDecision?.({ kind, destination: describeDestination(url), refusal });
    return refusal;
  };

  const executor = input.executor as (HttpExecutorLike & { [GUARDED]?: true }) | null | undefined;
  if (executor && executor[GUARDED] !== true) {
    const createRequest = executor.createRequest;
    executor.createRequest = function guardedCreateRequest(options: RequestOptionsLike, callback) {
      const target = requestTargetOf(options ?? {});
      const url = typeof target === "string" && target !== "host-override" ? target : "";
      const refusal =
        target === "host-override"
          ? decide("request", url, "host-override")
          : target === undefined
            ? decide("request", url, "invalid-url")
            : decide("request", target);
      if (refusal !== null) {
        return new RefusedUpdateRequest(
          new StarkUpdateRequestRefusedError({
            reason: refusal,
            destination: describeDestination(url),
            redirect: false,
          }),
        );
      }
      const request: ClientRequestLike = createRequest.call(this, options, callback);
      guardRedirects(request);
      return request;
    };
    executor[GUARDED] = true;
  }

  function guardRedirects(request: ClientRequestLike): void {
    let refused = false;
    // Registered before electron-updater adds its own listener, so it runs first.
    request.on("redirect", (_statusCode: number, _method: string, redirectUrl: string) => {
      const refusal = decide("redirect", String(redirectUrl));
      if (refusal === null) return;
      refused = true;
      request.abort();
      if (request.listenerCount("error") > 0) {
        request.emit(
          "error",
          new StarkUpdateRequestRefusedError({
            reason: refusal,
            destination: describeDestination(String(redirectUrl)),
            redirect: true,
          }),
        );
      }
    });
    const followRedirect = request.followRedirect;
    if (typeof followRedirect === "function") {
      request.followRedirect = () => {
        if (!refused) followRedirect.call(request);
      };
    }
  }

  const native = input.nativeUpdater as (NativeUpdaterLike & { [GUARDED]?: true }) | undefined;
  if (native && native[GUARDED] !== true) {
    const setFeedURL = native.setFeedURL;
    native.setFeedURL = function guardedSetFeedURL(options: { readonly url?: unknown }) {
      const url = String(options?.url ?? "");
      const allowed = isSquirrelHandoffFeedUrl(url);
      input.onDecision?.({
        kind: "native-feed",
        destination: describeDestination(url),
        refusal: allowed ? null : "origin",
      });
      if (allowed) {
        setFeedURL.call(this, options);
        return;
      }
      input.onNativeRefused?.(
        new StarkUpdateRequestRefusedError({
          reason: "origin",
          destination: describeDestination(url),
          redirect: false,
        }),
      );
    };
    native[GUARDED] = true;
  }

  const session = input.session as (SessionLike & { [GUARDED]?: true }) | undefined;
  if (session && session[GUARDED] !== true) {
    session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: decide("session", details.url) !== null });
    });
    session[GUARDED] = true;
  }
}

// ---------------------------------------------------------------------------
// The decision U1 asks for

export const DESKTOP_UPDATE_DISABLED_REASONS = [
  "unsupported-platform",
  "development-build",
  "invalid-update-policy",
  "no-update-feed",
  "untrusted-update-feed",
  "disabled-by-environment",
  "not-activated",
  "unsigned-build",
  "untrusted-signature",
] as const;
export type DesktopUpdateDisabledReason = (typeof DESKTOP_UPDATE_DISABLED_REASONS)[number];

export type DesktopUpdateFeedDecision =
  | { readonly enabled: true; readonly feed: ValidatedStarkUpdateFeed }
  | {
      readonly enabled: false;
      readonly reason: DesktopUpdateDisabledReason;
      /** A problem code for logs, such as `origin-not-allowed` or `team-mismatch`. */
      readonly detail: string | null;
    };

export interface DesktopUpdateFeedInputs {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  /** `STARK_CODE_DISABLE_AUTO_UPDATE` asked for updates to be off. */
  readonly disabledByEnv: boolean;
  /** The activation switch (`DESKTOP_AUTO_UPDATE_ACTIVATED`); it governs Stark feeds. */
  readonly activated: boolean;
  /** Resources/app-update.yml, or undefined when the app has none. */
  readonly appUpdateYml: string | undefined;
  /** The packaged package.json that carries the baked policy. */
  readonly appPackageJson: string | undefined;
  readonly ownership?: UpdateOwnership;
}

const disabled = (
  reason: DesktopUpdateDisabledReason,
  detail: string | null = null,
): DesktopUpdateFeedDecision => ({ enabled: false, reason, detail });

/**
 * Everything but the signature, in the order the reasons should be shown.
 * Returns the validated feed when only the signature check remains.
 */
function checkDesktopUpdateConfiguration(
  input: DesktopUpdateFeedInputs,
): DesktopUpdateFeedDecision {
  const ownership = input.ownership ?? STARK_UPDATE_OWNERSHIP;
  if (input.platform !== "darwin") return disabled("unsupported-platform");
  if (!input.isPackaged) return disabled("development-build");
  const baked = readBakedUpdatePolicy(input.appPackageJson);
  if (!baked.ok) return disabled("invalid-update-policy");
  if (baked.policy.kind === "none") {
    return input.appUpdateYml === undefined
      ? disabled("no-update-feed")
      : disabled("untrusted-update-feed", "feed-not-expected");
  }
  if (input.appUpdateYml === undefined) {
    return disabled("untrusted-update-feed", "app-update-missing");
  }
  const validation = validateStarkUpdateFeed(input.appUpdateYml, baked.policy, ownership);
  if (!validation.ok) {
    return disabled("untrusted-update-feed", validation.urlProblem ?? validation.problem);
  }
  if (input.disabledByEnv) return disabled("disabled-by-environment");
  // The owner's activation switch governs Stark feeds. A mock feed is an
  // explicit local rehearsal build (loopback only, never Developer ID, never
  // published), which must run the real updater before activation.
  if (!input.activated && validation.feed.kind === "stark") return disabled("not-activated");
  return { enabled: true, feed: validation.feed };
}

/** `checkDesktopUpdateConfiguration` plus the signature check on `codesign` output. */
export function decideDesktopUpdateFeed(
  input: DesktopUpdateFeedInputs & { readonly codesignOutput: string | undefined },
): DesktopUpdateFeedDecision {
  const configuration = checkDesktopUpdateConfiguration(input);
  if (!configuration.enabled) return configuration;
  if (input.codesignOutput === undefined) return disabled("untrusted-signature", "unreadable");
  const problem = checkOwnSignature(
    parseCodeSignatureSummary(input.codesignOutput),
    configuration.feed.kind,
    input.ownership ?? STARK_UPDATE_OWNERSHIP,
  );
  if (problem === null) return configuration;
  return problem === "unsigned" || problem === "ad-hoc"
    ? disabled("unsigned-build", problem)
    : disabled("untrusted-signature", problem);
}

/**
 * The one call the updater makes before it configures anything: reads the
 * packaged app-update.yml and package.json, checks them, and only then asks
 * `codesign` about the running app. A disabled decision means: register no
 * listeners, set no feed and send no requests.
 */
export const resolveDesktopUpdateFeed = Effect.fn("resolveDesktopUpdateFeed")(function* (
  input: Omit<DesktopUpdateFeedInputs, "appUpdateYml" | "appPackageJson"> & {
    readonly appUpdateYmlPath: string;
    readonly appPackageJsonPath: string;
    /** The running `.app` bundle. */
    readonly appBundlePath: string;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const readOptional = (path: string) =>
    fileSystem.readFileString(path).pipe(Effect.option, Effect.map(Option.getOrUndefined));
  const inputs: DesktopUpdateFeedInputs = {
    ...input,
    appUpdateYml: yield* readOptional(input.appUpdateYmlPath),
    appPackageJson: yield* readOptional(input.appPackageJsonPath),
  };
  const configuration = checkDesktopUpdateConfiguration(inputs);
  if (!configuration.enabled) return configuration;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const codesignOutput = yield* spawner
    .string(
      ChildProcess.make("/usr/bin/codesign", [
        "--display",
        "--verbose=2",
        "-r-",
        input.appBundlePath,
      ]),
      { includeStderr: true },
    )
    .pipe(Effect.option, Effect.map(Option.getOrUndefined));
  return decideDesktopUpdateFeed({ ...inputs, codesignOutput });
});
