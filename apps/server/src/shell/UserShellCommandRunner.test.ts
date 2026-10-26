// Real process-group and file-stream failure checks need the native boundaries.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as UserShell from "./UserShellCommandRunner.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-user-shell-" });
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  yield* fs.makeDirectory(cwd);
  yield* fs.makeDirectory(home);
  yield* fs.writeFileString(
    path.join(home, ".bash_profile"),
    "export STARK_TEST_LOGIN_PROFILE=loaded\n",
  );
  const layer = UserShell.layer.pipe(
    Layer.provide(ServerConfig.layerTest(cwd, path.join(root, "state"))),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        HOME: home,
        SHELL: "/bin/bash",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "sdk",
        STARK_CODE_SECRET: "synthetic-secret",
        VITE_TEST_SECRET: "synthetic-secret",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_TRACES_EXPORTER: "otlp",
        KEEP_USER_VALUE: "kept",
      }),
    ),
  );
  return { fs, path, root, cwd, home, layer };
});
const withRunner = <A, E, R>(
  use: (fixture: Effect.Success<typeof makeFixture>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    return yield* use(fixture).pipe(Effect.provide(fixture.layer));
  });

const command = (cwd: string, id: string, text: string) => ({
  threadId: "user-shell-test-thread",
  commandId: id,
  cwd,
  command: text,
});
const processStopped = (pid: number) => {
  try {
    const state = NodeChildProcess.execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state === "" || state.startsWith("Z");
  } catch (error) {
    return (error as { status?: number }).status === 1;
  }
};

it.layer(NodeServices.layer, { excludeTestServices: true })("UserShellCommandRunner", (it) => {
  it.effect(
    "uses the requested folder and a login shell with closed stdin, separate streams, and exit status",
    () =>
      withRunner(({ cwd }) =>
        Effect.gen(function* () {
          const runner = yield* UserShell.UserShellCommandRunner;
          const result = yield* runner.run(
            command(
              cwd,
              "basic",
              'pwd; shopt -q login_shell && echo LOGIN; echo "$STARK_TEST_LOGIN_PROFILE"; read value; printf "READ[%s]\\n" "$value"; printf "\\033[31mred\\033[0m\\n"; printf "errline\\n" >&2; exit 3',
            ),
          );
          expect(result.stdout).toContain(`${cwd}\nLOGIN\nloaded\nREAD[]\nred\n`);
          expect(result.stderr).toBe("errline\n");
          expect(result.output).toContain("\u001b[31mred\u001b[0m");
          expect(result.exitCode).toBe(3);
          expect(result.interrupted).toBe(false);
          expect(result.timedOut).toBe(false);
          expect(result.durationMs).toBeGreaterThanOrEqual(0);
        }),
      ),
  );
  it.effect(
    "cleans app secrets and nested-Claude flags while enforcing privacy and retaining personal environment",
    () =>
      withRunner(({ cwd }) =>
        Effect.gen(function* () {
          const runner = yield* UserShell.UserShellCommandRunner;
          const result = yield* runner.run({
            ...command(cwd, "environment", node("console.log(JSON.stringify(process.env))")),
            env: {
              STARK_CODE_RUNTIME_SECRET: "blocked",
              VITE_OVERRIDE: "blocked",
              CLAUDE_CODE_ENABLE_TELEMETRY: "1",
              KEEP_RUNTIME_VALUE: "kept",
            },
          });
          const env = JSON.parse(result.stdout);
          expect(env).toMatchObject({
            KEEP_USER_VALUE: "kept",
            KEEP_RUNTIME_VALUE: "kept",
            CLAUDE_CODE_ENABLE_TELEMETRY: "0",
            OTEL_TRACES_EXPORTER: "none",
            PAGER: "cat",
            GIT_PAGER: "cat",
            TERM: "dumb",
          });
          for (const name of [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "STARK_CODE_SECRET",
            "STARK_CODE_RUNTIME_SECRET",
            "VITE_TEST_SECRET",
            "VITE_OVERRIDE",
          ])
            expect(env).not.toHaveProperty(name);
        }),
      ),
  );
  it.effect("keeps the complete output file and sends bounded, ANSI-free model heads", () =>
    withRunner(({ cwd, fs }) =>
      Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        const result = yield* runner.run(
          command(
            cwd,
            "model-output",
            node('process.stdout.write("A".repeat(40000));process.stderr.write("ERR")'),
          ),
        );
        expect(result.stdout).toMatch(/^A{2000}\n\[output truncated: full output saved at /);
        expect(result.stderr).toContain("ERR\n[output truncated:");
        expect(result.output.length).toBe(40003);
        expect(yield* fs.readFileString(result.fullOutputPath!)).toHaveLength(40003);
      }),
    ),
  );
  it.effect(
    "caps display at one MiB and stored output at 64 MiB under real stream backpressure",
    () =>
      withRunner(({ cwd, fs }) =>
        Effect.gen(function* () {
          const runner = yield* UserShell.UserShellCommandRunner;
          const result = yield* runner.run(
            command(
              cwd,
              "file-cap",
              node('process.stdout.write(Buffer.alloc(65 * 1024 * 1024, "x"))'),
            ),
          );
          expect(result.exitCode).toBe(0);
          expect(Buffer.byteLength(result.output)).toBe(1024 * 1024);
          expect(result.outputOmitted).toBe(true);
          expect((yield* fs.stat(result.fullOutputPath!)).size).toBe(64n * 1024n * 1024n);
        }),
      ),
  );
  it.effect("saves native Codex fallback output with a private file and valid UTF-8 preview", () =>
    withRunner(({ fs }) =>
      Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        const text = "😀".repeat(262_145);
        const result = yield* runner.saveOutput({
          threadId: "fallback-thread",
          commandId: "fallback-output",
          output: text,
        });
        expect(result.outputOmitted).toBe(true);
        expect(Buffer.byteLength(result.output)).toBe(1024 * 1024);
        expect(result.output).not.toContain("�");
        expect(yield* fs.readFileString(result.fullOutputPath!)).toBe(text);
        expect(NodeFS.statSync(result.fullOutputPath!).mode & 0o077).toBe(0);
      }),
    ),
  );
  it.effect("decodes UTF-8 split across child writes without replacing complete characters", () =>
    withRunner(({ cwd }) =>
      Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        const result = yield* runner.run(
          command(
            cwd,
            "unicode",
            node(
              'const b=Buffer.from("😀�");process.stdout.write(b.subarray(0,2));setImmediate(()=>process.stdout.write(b.subarray(2)))',
            ),
          ),
        );
        expect(result.stdout).toBe("😀�");
        expect(result.output).toBe("😀�");
      }),
    ),
  );
  it.effect("rejects a null or missing folder without starting a child", () =>
    withRunner(({ cwd }) =>
      Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        expect(
          yield* runner
            .run({ ...command(cwd, "null-folder", "echo bad"), cwd: null })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "no-folder" });
        expect(
          yield* runner
            .run(command(`${cwd}/does-not-exist`, "missing-folder", "echo bad"))
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "folder-not-found" });
      }),
    ),
  );
  it.effect("Stop cancels filesystem preflight before spawn and blocks a duplicate launch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let armed = true;
      const fs = FileSystem.FileSystem.of({
        ...fixture.fs,
        stat: (path) => {
          if (path === fixture.cwd && armed) {
            armed = false;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(fixture.fs.stat(path)),
            );
          }
          return fixture.fs.stat(path);
        },
      });
      yield* Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        const job = yield* Effect.forkScoped(
          runner.run(command(fixture.cwd, "preflight", "touch MUST_NOT_RUN")),
        );
        yield* Deferred.await(entered);
        expect(
          yield* runner.run(command(fixture.cwd, "preflight", "echo duplicate")).pipe(Effect.flip),
        ).toMatchObject({ reason: "already-running" });
        yield* runner.cancel("preflight");
        const result = yield* Fiber.join(job);
        expect(result).toMatchObject({ interrupted: true, stdout: "", exitCode: null });
        expect(result).not.toHaveProperty("fullOutputPath");
        yield* Deferred.succeed(release, undefined);
        expect(yield* fixture.fs.exists(fixture.path.join(fixture.cwd, "MUST_NOT_RUN"))).toBe(
          false,
        );
        expect(
          (yield* runner.run(command(fixture.cwd, "preflight", "echo safe retry"))).stdout,
        ).toBe("safe retry\n");
      }).pipe(
        Effect.provide(fixture.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)))),
      );
    }),
  );
  it.effect("Stop interrupts the live command and retains streamed partial output", () =>
    withRunner(({ cwd }) =>
      Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        const emitted = yield* Deferred.make<void>();
        let streamed = "";
        const job = yield* Effect.forkScoped(
          runner.run({
            ...command(cwd, "stop", node("console.log(process.pid);setInterval(()=>{},1000)")),
            onOutput: (delta) =>
              Effect.sync(() => {
                streamed += delta;
              }).pipe(Effect.andThen(Deferred.succeed(emitted, undefined)), Effect.asVoid),
          }),
        );
        yield* Deferred.await(emitted);
        yield* runner.cancel("stop");
        const result = yield* Fiber.join(job);
        expect(result.interrupted).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toBe(streamed);
        expect(processStopped(Number(result.stdout.trim()))).toBe(true);
      }),
    ),
  );
  it.effect(
    "timeout kills the captured process group, including descendants that ignore SIGTERM",
    () =>
      withRunner(({ cwd }) =>
        Effect.gen(function* () {
          const runner = yield* UserShell.UserShellCommandRunner;
          const script = `const cp=require("node:child_process");process.on("SIGTERM",()=>{});const child=cp.spawn(process.execPath,["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(process.pid+":"+child.pid);setInterval(()=>{},1000)`;
          const result = yield* runner.run({
            ...command(cwd, "timeout-group", node(script)),
            timeoutMs: 500,
          });
          expect(result.timedOut).toBe(true);
          expect(result.interrupted).toBe(false);
          const pids = result.stdout.trim().split(":").map(Number);
          expect(pids).toHaveLength(2);
          for (const pid of pids) expect(processStopped(pid)).toBe(true);
        }),
      ),
  );
  it.effect("rejects a file flush failure after the child closes instead of hanging", () =>
    withRunner(({ cwd }) =>
      Effect.gen(function* () {
        const runner = yield* UserShell.UserShellCommandRunner;
        vi.mocked(NodeFS.createWriteStream).mockImplementationOnce(
          () =>
            new NodeStream.Writable({
              write: (_chunk, _encoding, done) => done(),
              final: (done) => done(new Error("simulated disk full during final flush")),
            }) as NodeFS.WriteStream,
        );
        expect(
          yield* runner.run(command(cwd, "final-write-error", "printf hello")).pipe(Effect.flip),
        ).toMatchObject({ reason: "output-storage" });
        expect(
          (yield* runner.run(command(cwd, "final-write-error", "echo recovered"))).stdout,
        ).toBe("recovered\n");
      }),
    ),
  );
});
