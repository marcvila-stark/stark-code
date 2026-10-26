// The health probe bounds bytes as they arrive, never follows redirects, and sends no Origin.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { LocalStarkPage } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  isMirrorFollowUrl,
  isOpenableStarkPageLink,
  type StarkPagesMirror,
} from "@starkfuture/shared/starkPages";
import * as ElectronShell from "../electron/ElectronShell.ts";
import {
  starkWorkbenchEnvironment,
  validateStarkWorkbenchRoot,
} from "@starkfuture/shared/starkWorkbench";

const MirrorDescriptor = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 4317, maximum: 4337 })),
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
});
const decodeMirror = Schema.decodeUnknownOption(Schema.fromJsonString(MirrorDescriptor));
const decodeHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ok: Schema.Literal(true), root: Schema.String, pid: Schema.Int }),
  ),
);
const decodePage = Schema.decodeUnknownOption(LocalStarkPage);
type VerifiedMirror = StarkPagesMirror & { readonly token: string };

export class StarkPages extends Context.Service<
  StarkPages,
  {
    readonly findMirror: (projectRoot: string) => Effect.Effect<StarkPagesMirror | null>;
    readonly ensureMirror: (projectRoot: string) => Effect.Effect<StarkPagesMirror | null>;
    readonly listPages: (projectRoot: string) => Effect.Effect<readonly LocalStarkPage[] | null>;
    readonly workbenchAvailable: Effect.Effect<boolean>;
    readonly shutdown: Effect.Effect<void>;
    readonly openFollow: (input: {
      readonly projectRoot: string;
      readonly url: unknown;
    }) => Effect.Effect<boolean>;
    readonly openLink: (url: unknown) => Effect.Effect<boolean>;
  }
>()("@starkfuture/desktop/starkPages/StarkPages") {}

interface MirrorRuntime {
  readonly kitRoot: string;
  readonly nodePath: string;
  readonly startupTimeoutMs?: number;
  readonly env?: Record<string, string | undefined>;
}

const make = (runtime: MirrorRuntime) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const shell = yield* ElectronShell.ElectronShell;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.fork(yield* Effect.scope);
    let closing = false;
    const mutex = yield* Semaphore.make(1);
    const starting = new Map<string, Fiber.Fiber<StarkPagesMirror | null>>();
    const owned = new Map<string, Scope.Closeable>();
    const bundledKit = validateStarkWorkbenchRoot(runtime.kitRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const findVerifiedMirror = Effect.fn("StarkPages.findVerifiedMirror")(function* (
      projectRoot: string,
    ) {
      if (projectRoot.length > 4096 || !path.isAbsolute(projectRoot)) return null;
      const root = path.resolve(projectRoot);
      const file = path.join(root, "pages", ".spage", "mirror.json");
      const stat = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(stat) || stat.value.type !== "File" || Number(stat.value.size) > 8192)
        return null;
      const text = yield* fs.readFileString(file).pipe(Effect.option);
      if (Option.isNone(text)) return null;
      const descriptor = decodeMirror(text.value);
      if (Option.isNone(descriptor)) return null;
      const mirror = descriptor.value;
      return yield* Effect.callback<VerifiedMirror | null>((resume) => {
        let settled = false;
        const finish = (result: VerifiedMirror | null) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(result));
        };
        // A single Node request sends no Origin and never follows redirects.
        // The secret stays here; the renderer receives only the validated port/root.
        const request = NodeHttp.request(
          {
            hostname: "127.0.0.1",
            port: mirror.port,
            method: "GET",
            path: "/health",
            headers: { "X-Spage-Token": mirror.token },
            signal: AbortSignal.timeout(2000),
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              finish(null);
              return;
            }
            response.setEncoding("utf8");
            let body = "";
            response.on("data", (chunk: string) => {
              body += chunk;
              if (Buffer.byteLength(body) > 8192) {
                request.destroy();
                finish(null);
              }
            });
            response.on("error", () => finish(null));
            response.on("end", () => {
              const health = decodeHealth(body);
              finish(
                Option.isSome(health) &&
                  path.resolve(health.value.root) === root &&
                  health.value.pid === mirror.pid
                  ? { root, port: mirror.port, token: mirror.token }
                  : null,
              );
            });
          },
        );
        request.on("error", () => finish(null));
        request.setTimeout(2000, () => {
          request.destroy();
          finish(null);
        });
        request.end();
        return Effect.sync(() => request.destroy());
      });
    });
    const findMirror = (root: string) =>
      findVerifiedMirror(root).pipe(
        Effect.map((mirror): StarkPagesMirror | null =>
          mirror ? { root: mirror.root, port: mirror.port } : null,
        ),
      );
    const listPages = Effect.fn("StarkPages.listPages")(function* (root: string) {
      const mirror = yield* findVerifiedMirror(root);
      if (!mirror) return null;
      return yield* Effect.callback<readonly LocalStarkPage[] | null>((resume) => {
        let settled = false;
        const finish = (pages: readonly LocalStarkPage[] | null) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(pages));
        };
        const request = NodeHttp.request(
          {
            hostname: "127.0.0.1",
            port: mirror.port,
            path: "/api/pages",
            method: "GET",
            headers: { "X-Spage-Token": mirror.token },
            signal: AbortSignal.timeout(2000),
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              finish(null);
              return;
            }
            response.setEncoding("utf8");
            let body = "";
            response.on("data", (chunk: string) => {
              body += chunk;
              if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
                request.destroy();
                finish(null);
              }
            });
            response.on("error", () => finish(null));
            response.on("end", () => {
              if (settled) return;
              try {
                const data: unknown = JSON.parse(body);
                if (!Array.isArray(data) || data.length > 2000) {
                  finish(null);
                  return;
                }
                const pages: LocalStarkPage[] = [];
                for (const row of data) {
                  const page = decodePage(row);
                  if (Option.isSome(page)) pages.push(page.value);
                }
                finish(pages);
              } catch {
                finish(null);
              }
            });
          },
        );
        request.on("error", () => finish(null));
        request.end();
        return Effect.sync(() => request.destroy());
      });
    });
    const startMirror = Effect.fn("StarkPages.startMirror")(function* (root: string) {
      const existing = yield* findMirror(root);
      if (existing !== null) return existing;
      const rootStat = yield* fs.stat(root).pipe(Effect.option);
      if (Option.isNone(rootStat) || rootStat.value.type !== "Directory") return null;
      const kit = yield* bundledKit.pipe(Effect.option);
      if (Option.isNone(kit)) return null;
      const entry = path.join(kit.value, "packages", "spage", "bin", "spage.js");
      const previous = owned.get(root);
      if (previous) yield* Scope.close(previous, Exit.void);
      const childScope = yield* Scope.fork(scope);
      owned.set(root, childScope);
      const result = yield* Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(runtime.nodePath, [entry, "serve", "--root", root], {
              cwd: root,
              env: {
                ...runtime.env,
                ...starkWorkbenchEnvironment(kit.value, runtime.nodePath),
                ELECTRON_RUN_AS_NODE: "1",
              },
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              killSignal: "SIGTERM",
              forceKillAfter: "2 seconds",
            }),
          )
          .pipe(Scope.provide(childScope));
        // The kit writes the descriptor after binding. Readiness always includes the
        // authenticated health check; process output never becomes renderer data.
        return yield* Effect.gen(function* () {
          while (true) {
            const mirror = yield* findMirror(root);
            if (mirror !== null) return mirror;
            if (!(yield* child.isRunning)) return null;
            yield* Effect.sleep("100 millis");
          }
        }).pipe(
          Effect.timeoutOption(runtime.startupTimeoutMs ?? 10000),
          Effect.map(Option.getOrNull),
        );
      }).pipe(Effect.orElseSucceed(() => null));
      if (result === null) {
        yield* Scope.close(childScope, Exit.void);
        owned.delete(root);
      }
      return result;
    });
    const ensureMirror = Effect.fn("StarkPages.ensureMirror")(function* (projectRoot: string) {
      if (closing || projectRoot.length > 4096 || !path.isAbsolute(projectRoot)) return null;
      const root = path.resolve(projectRoot);
      const fiber = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const pending = starting.get(root);
          if (pending) return pending;
          const launched = yield* startMirror(root).pipe(
            Effect.ensuring(Effect.sync(() => starting.delete(root))),
            Effect.forkIn(scope),
          );
          starting.set(root, launched);
          return launched;
        }),
      );
      return yield* Fiber.join(fiber);
    });
    const openFollow = Effect.fn("StarkPages.openFollow")(function* (input: {
      readonly projectRoot: string;
      readonly url: unknown;
    }) {
      const mirror = yield* findMirror(input.projectRoot);
      if (mirror === null || !isMirrorFollowUrl(input.url, mirror.port)) return false;
      return yield* shell.openExternal(input.url);
    });
    return StarkPages.of({
      findMirror,
      ensureMirror,
      listPages,
      workbenchAvailable: Effect.isSuccess(bundledKit),
      shutdown: Effect.sync(() => {
        closing = true;
      }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
      openFollow,
      openLink: (raw) =>
        isOpenableStarkPageLink(raw) ? shell.openExternal(raw) : Effect.succeed(false),
    });
  });

export const layer = (runtime: MirrorRuntime) => Layer.effect(StarkPages, make(runtime));
