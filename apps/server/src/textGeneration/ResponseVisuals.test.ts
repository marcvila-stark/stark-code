import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  ProjectId,
} from "@starkfuture/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ResponseVisuals from "./ResponseVisuals.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const threadId = ThreadId.make("visual-thread");
const projectId = ProjectId.make("visual-project");

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const useful = {
  summary: "Two steps.",
  table: null,
  flowchart: {
    nodes: [
      { id: "a", label: "Prepare" },
      { id: "b", label: "Review" },
    ],
    edges: [{ from: "a", to: "b" }],
  },
  reason: null,
};
const envelope = (result: unknown) =>
  json({
    result: json(result),
    usage: {
      input_tokens: 120,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 60,
    },
    total_cost_usd: 0.001,
    modelUsage: { "claude-sonnet-5-5": {} },
  });
const base = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "stark-response-visual-test-" }),
  ServerSettings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        config: { binaryPath: "claude", homePath: "" },
      },
    },
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-visual-cache-test-" });
  const home = path.join(stateDir, "home");
  const executable = path.join(home, ".local", "bin", "claude");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls: ChildProcess.StandardCommand[] = [];
  const prompts: string[] = [];
  let closed = 0;
  const control = {
    output: envelope(useful),
    stderr: "",
    exitCode: 0,
    wait: false,
    started,
    threadExists: true,
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Expected direct CLI command");
      calls.push(command);
      const stdin = command.options.stdin;
      if (stdin && typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream))
        prompts.push(
          yield* stdin.stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          ),
        );
      expect(yield* fs.readDirectory(command.options.cwd!)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed++;
        }),
      );
      yield* Deferred.succeed(control.started, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: (control.wait ? Deferred.await(release) : Effect.void).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(control.exitCode)),
        ),
        isRunning: Effect.succeed(control.wait),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(control.output)),
        stderr: Stream.encodeText(Stream.make(control.stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const build = ResponseVisuals.ResponseVisuals.pipe(
    Effect.provide(
      ResponseVisuals.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(control.threadExists ? { ...liveThreadShell(id), projectId } : null),
          }),
        ),
      ),
    ),
    Effect.provideService(ServerConfig.ServerConfig, { ...config, stateDir }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, {
      PATH: "/usr/bin:/bin",
      HOME: home,
      CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
      ANTHROPIC_MODEL: "expensive",
      NODE_OPTIONS: "--import unsafe",
    }),
  );
  return {
    fs,
    path,
    stateDir,
    executable,
    build,
    service: yield* build,
    calls,
    prompts,
    control,
    started,
    release,
    get closed() {
      return closed;
    },
  };
});

it.layer(base)("ResponseVisuals", (it) => {
  it.effect(
    "uses the implicit default Claude instance and finds a native install with a Dock PATH",
    () =>
      Effect.gen(function* () {
        expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
        const f = yield* fixture.pipe(Effect.provide(ServerSettings.layerTest()));
        const result = yield* f.service.format({ threadId, answer: "Prepare, then review." });
        expect(result.summary).toBe("Two steps.");
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.command).toBe(f.executable);
        expect(f.calls[0]!.options.env?.PATH).toMatch(/^\/usr\/bin:\/bin:/);
      }).pipe(Effect.scoped),
  );

  it.effect("uses only the selected answer, an isolated Sonnet invocation, and reports usage", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const answer = "UNIQUE_SELECTED_ANSWER: Prepare, then review.";
      const result = yield* f.service.format({ threadId, answer, language: "English" });
      expect(result.mermaid).toBe('flowchart TD\nna["Prepare"]\nnb["Review"]\nna --> nb');
      expect(result.generationUsage).toEqual({
        freshInputTokens: 120,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 10,
        outputTokens: 60,
        costUsd: 0.001,
      });
      expect(f.calls).toHaveLength(1);
      const command = f.calls[0]!;
      const args = command.args;
      for (const [flag, value] of [
        ["--model", "claude-sonnet-5-5"],
        ["--effort", "low"],
        ["--max-turns", "1"],
        ["--max-budget-usd", "0.08"],
        ["--tools", ""],
        ["--setting-sources", ""],
        ["--mcp-config", '{"mcpServers":{}}'],
      ])
        expect(args[args.indexOf(flag!) + 1]).toBe(value);
      for (const flag of [
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--no-chrome",
      ])
        expect(args).toContain(flag);
      expect(args).not.toContain("--json-schema");
      expect(args.join(" ")).not.toContain(answer);
      expect(args[args.indexOf("--system-prompt") + 1]).toContain(
        "Every edge must refer to an existing node ID",
      );
      expect(command.options.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
      expect(command.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
      expect(command.options.env?.MAX_THINKING_TOKENS).toBe("0");
      expect(command.options.env?.ANTHROPIC_MODEL).toBeUndefined();
      expect(command.options.env?.NODE_OPTIONS).toBeUndefined();
      expect(fromJson(f.prompts[0])).toEqual({
        answer,
        language: "English",
        visualRequest: "auto",
      });
      expect(yield* f.fs.exists(command.options.cwd!)).toBe(false);
      expect(f.closed).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reuses a durable bounded cache and keys language and visual preference separately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = { threadId, answer: "unique-secret-answer" };
        const first = yield* f.service.format(input);
        expect((yield* f.service.format(input)).cacheHit).toBe(true);
        const restored = yield* f.build;
        expect(yield* restored.format(input)).toEqual({ ...first, cacheHit: true });
        expect(f.calls).toHaveLength(1);
        yield* restored.format({ ...input, language: "Spanish" });
        yield* restored.format({ ...input, visualRequest: "table" });
        expect(f.calls).toHaveLength(3);
        const file = f.path.join(f.stateDir, "response-visuals-v1.json");
        expect(yield* f.fs.readFileString(file)).not.toContain(input.answer);
        expect((yield* f.fs.stat(file)).mode & 0o777).toBe(0o600);
        for (let i = 0; i < 65; i++) yield* restored.format({ threadId, answer: `answer ${i}` });
        const cached = fromJson(yield* f.fs.readFileString(file));
        expect(Array.isArray(cached) && cached.length).toBe(64);
        expect((yield* f.fs.stat(file)).size <= 1024n * 1024n).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("summarizes only the selected answer with a smaller bounded Sonnet call", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const summaryBullets = [
        "The change is implemented, but live verification is still pending.",
        "Review the result before publishing.",
      ];
      f.control.output = envelope({
        ...useful,
        summary: "The change needs verification before publishing.",
        summaryBullets,
        table: { columns: ["Step", "Action"], rows: [["One", "Review"]] },
      });
      const answer =
        "SELECTED ANSWER: Implemented the change. Live verification is pending. Review before publishing.";
      const result = yield* f.service.format({ threadId, answer, visualRequest: "summary" });
      expect(result.summary).toBe("The change needs verification before publishing.");
      expect(result.summaryBullets).toEqual(summaryBullets);
      expect(result.table).toBeNull();
      expect(result.mermaid).toBeNull();
      expect(result.reason).toBeNull();
      expect(f.calls).toHaveLength(1);
      const command = f.calls[0]!;
      const args = command.args;
      expect(command.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("768");
      for (const [flag, value] of [
        ["--model", "claude-sonnet-5-5"],
        ["--effort", "low"],
        ["--max-turns", "1"],
        ["--max-budget-usd", "0.08"],
        ["--tools", ""],
        ["--mcp-config", '{"mcpServers":{}}'],
      ])
        expect(args[args.indexOf(flag!) + 1]).toBe(value);
      expect(args[args.indexOf("--system-prompt") + 1]).toContain(
        "do not turn a proposal or unverified claim into a completed action",
      );
      expect(args[args.indexOf("--system-prompt") + 1]).not.toContain('"flowchart"');
      expect(args.join(" ")).not.toContain(answer);
      expect(fromJson(f.prompts[0])).toEqual({
        answer,
        language: "same as answer",
        visualRequest: "summary",
      });
      expect(result.generationUsage?.outputTokens).toBe(60);
    }).pipe(Effect.scoped),
  );

  it.effect("caches summaries independently from visuals and restores the bullets", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = { threadId, answer: "Prepare the change, then review the pending work." };
      const visual = yield* f.service.format(input);
      expect(visual.summaryBullets).toBeUndefined();
      const summaryBullets = ["Prepare the change.", "Review the pending work."];
      f.control.output = envelope({ summary: null, summaryBullets });
      const summary = yield* f.service.format({ ...input, visualRequest: "summary" });
      expect(summary.summaryBullets).toEqual(summaryBullets);
      expect(summary.cacheHit).toBe(false);
      expect(f.calls).toHaveLength(2);
      const restored = yield* f.build;
      expect(yield* restored.format({ ...input, visualRequest: "summary" })).toEqual({
        ...summary,
        cacheHit: true,
      });
      expect(yield* restored.format(input)).toEqual({ ...visual, cacheHit: true });
      expect(f.calls).toHaveLength(2);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: { [ProviderInstanceId.make("claudeAgent")]: { enabled: false } },
          },
        },
      });
      expect(
        (yield* restored.format({ ...input, visualRequest: "summary" }).pipe(Effect.flip)).reason,
      ).toBe("disabled");
      expect(f.calls).toHaveLength(2);
      yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a valid summary part but never substitutes a diagram or reason for it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.control.output = envelope({ summary: "x".repeat(281), summaryBullets: ["Review first."] });
      const bullets = yield* f.service.format({
        threadId,
        answer: "Review first, then publish.",
        visualRequest: "summary",
      });
      expect(bullets.summary).toBeNull();
      expect(bullets.summaryBullets).toEqual(["Review first."]);
      f.control.output = envelope({ summary: "Review first.", summaryBullets: ["x".repeat(241)] });
      const lead = yield* f.service.format({
        threadId,
        answer: "Review first, and publish only when approved.",
        visualRequest: "summary",
      });
      expect(lead.summary).toBe("Review first.");
      expect(lead.summaryBullets).toBeUndefined();
      for (const summaryBullets of [
        undefined,
        [],
        [""],
        ["   "],
        Array(6).fill("Too many bullets."),
      ]) {
        f.control.output = envelope({
          ...useful,
          summary: "   ",
          summaryBullets,
          reason: "The flowchart is enough.",
        });
        expect(
          (yield* f.service
            .format({ threadId, answer: "Prepare, then review.", visualRequest: "summary" })
            .pipe(Effect.flip)).reason,
        ).toBe("output");
      }
      expect(f.calls).toHaveLength(7);
      expect(f.closed).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("permits no additions with a reason and safely constructs diagram labels", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.control.output = envelope({
        summary: null,
        table: null,
        flowchart: null,
        reason: "Already concise.",
      });
      expect((yield* f.service.format({ threadId, answer: "Yes." })).reason).toBe(
        "Already concise.",
      );
      f.control.output = envelope({
        ...useful,
        flowchart: {
          ...useful.flowchart,
          nodes: [
            { id: "a", label: 'Prepare"\nclick a "https://evil.invalid"' },
            { id: "b", label: "Review" },
          ],
        },
      });
      const result = yield* f.service.format({ threadId, answer: "Prepare and review" });
      expect(result.mermaid?.split("\n")).toHaveLength(4);
      expect(result.mermaid).not.toContain("\nclick");
    }).pipe(Effect.scoped),
  );

  it.effect("checks the owning project's Claude setting before generation or cache access", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const settings = yield* ServerSettings.ServerSettingsService;
      const claude = ProviderInstanceId.make("claudeAgent");
      const input = { threadId, answer: "Project-specific answer" };
      yield* f.service.format(input);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [claude]: { enabled: false } } },
        },
      });
      expect((yield* f.service.format(input).pipe(Effect.flip)).reason).toBe("disabled");
      expect(f.calls).toHaveLength(1);
      yield* settings.updateSettings({
        providerInstances: {
          [claude]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false, config: {} },
        },
        projectSettingsOverrides: {
          [projectId]: null,
          [ProjectId.make("another-project")]: {
            providerInstances: { [claude]: { enabled: true } },
          },
        },
      });
      expect((yield* f.service.format(input).pipe(Effect.flip)).reason).toBe("disabled");
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [claude]: { enabled: true } } },
        },
      });
      expect((yield* f.service.format(input)).cacheHit).toBe(true);
      expect(f.calls).toHaveLength(1);
      f.control.threadExists = false;
      expect((yield* f.service.format(input).pipe(Effect.flip)).reason).toBe("unavailable");
      expect(f.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("serves a durable cache hit while an unrelated generation owns the busy gate", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = { threadId, answer: "Cached answer" };
      yield* f.service.format(input);
      const restored = yield* f.build;
      f.control.wait = true;
      f.control.started = yield* Deferred.make<void>();
      const running = yield* restored
        .format({ threadId, answer: "Uncached answer" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.control.started);
      expect((yield* restored.format(input)).cacheHit).toBe(true);
      expect(
        (yield* restored.format({ threadId, answer: "Other answer" }).pipe(Effect.flip)).reason,
      ).toBe("busy");
      expect(f.calls).toHaveLength(2);
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(running);
    }).pipe(Effect.scoped),
  );

  it.effect("shares an in-flight disk cache load between concurrent requests", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const crypto = yield* Crypto.Crypto;
      // A deterministic immediate digest makes both requests reach the loader together.
      const digest = { ...crypto, digest: () => Effect.succeed(new Uint8Array(32)) };
      const initial = yield* f.build.pipe(Effect.provideService(Crypto.Crypto, digest));
      const input = { threadId, answer: "Already saved" };
      yield* initial.format(input);
      const readStarted = yield* Deferred.make<void>();
      const readRelease = yield* Deferred.make<void>();
      let cacheReads = 0;
      const restored = yield* f.build.pipe(
        Effect.provideService(Crypto.Crypto, digest),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readFileString: (file, encoding) =>
            file === f.path.join(f.stateDir, "response-visuals-v1.json")
              ? Effect.gen(function* () {
                  cacheReads++;
                  yield* Deferred.succeed(readStarted, undefined);
                  yield* Deferred.await(readRelease);
                  return yield* f.fs.readFileString(file, encoding);
                })
              : f.fs.readFileString(file, encoding),
        }),
      );
      const requests = yield* Effect.all([restored.format(input), restored.format(input)], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(readStarted);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(readRelease, undefined);
      expect((yield* Fiber.join(requests)).map((result) => result.cacheHit)).toEqual([true, true]);
      expect(cacheReads).toBe(1);
      expect(f.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps valid additions when another addition has invalid shape or references", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const table = { columns: ["Step", "Action"], rows: [["One", "Prepare"]] };
      const malformedCharts = [
        { nodes: [{ id: "not an id", label: "A" }], edges: [] },
        { ...useful.flowchart, edges: [{ from: "a", to: "missing" }] },
        {
          ...useful.flowchart,
          nodes: [
            { id: "a", label: "A" },
            { id: "a", label: "B" },
          ],
        },
      ];
      for (const [index, flowchart] of malformedCharts.entries()) {
        f.control.output = envelope({ ...useful, table, flowchart });
        const result = yield* f.service.format({ threadId, answer: `Malformed chart ${index}` });
        expect(result.summary).toBe(useful.summary);
        expect(result.table).toEqual(table);
        expect(result.mermaid).toBeNull();
      }
      f.control.output = envelope({
        ...useful,
        summary: "x".repeat(281),
        table: { ...table, rows: [["one", "two", "extra"]] },
      });
      const diagram = yield* f.service.format({
        threadId,
        answer: "Valid diagram, invalid table and summary",
      });
      expect(diagram.summary).toBeNull();
      expect(diagram.table).toBeNull();
      expect(diagram.mermaid).toContain("na --> nb");
      expect(f.calls).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("logs only an exit code and a bounded redacted first stderr line", () => {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.gen(function* () {
      const f = yield* fixture;
      f.control.exitCode = 17;
      const answer = "CONFIDENTIAL selected answer";
      for (const stderr of [
        "error: unknown option 'sk-secret-value /Users/private/file'\n" + answer,
        answer + "\nerror: unknown option --bad",
        "Bearer token-secret-value " + "x".repeat(3000),
        "\u001b[31merror: permission denied /Users/private/file",
      ]) {
        f.control.stderr = stderr;
        expect((yield* f.service.format({ threadId, answer }).pipe(Effect.flip)).reason).toBe(
          "unavailable",
        );
      }
      f.control.exitCode = 0;
      f.control.output = answer;
      expect((yield* f.service.format({ threadId, answer }).pipe(Effect.flip)).reason).toBe(
        "output",
      );
      const rendered = json(logs);
      expect(rendered).toContain('"exitCode":17');
      expect(rendered).toContain('"exitCode":0');
      expect(rendered).toContain("error: unknown option [redacted]");
      expect(rendered).toContain('"stderrLine":"[redacted]"');
      for (const secret of [
        answer,
        "sk-secret-value",
        "/Users/private",
        "token-secret-value",
        "x".repeat(100),
      ])
        expect(rendered).not.toContain(secret);
      expect(logs).toHaveLength(5);
      expect(rendered.length).toBeLessThan(800);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })), Effect.scoped);
  });

  it.effect("rejects over-limit input and malformed output without repair or fallback calls", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const answer of ["", " ", "x".repeat(24_001), "界".repeat(20_000)]) {
        expect((yield* f.service.format({ threadId, answer }).pipe(Effect.flip)).reason).toBe(
          "invalid",
        );
      }
      expect(f.calls).toHaveLength(0);
      const invalidOutputs = [
        "not json",
        envelope({ summary: null, table: null, flowchart: null, reason: null }),
        "x".repeat(32 * 1024 + 1),
      ];
      for (const output of invalidOutputs) {
        f.control.output = output;
        const error = yield* f.service
          .format({ threadId, answer: "valid answer" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("output");
        expect(error.message).not.toContain(output);
      }
      expect(f.calls).toHaveLength(invalidOutputs.length);
      expect(f.closed).toBe(invalidOutputs.length);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects parallel generation, times out, and releases subprocess scope for a retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.control.wait = true;
        const running = yield* f.service
          .format({ threadId, answer: "Slow answer" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(f.started);
        expect(
          (yield* f.service.format({ threadId, answer: "Other answer" }).pipe(Effect.flip)).reason,
        ).toBe("busy");
        yield* TestClock.adjust("46 seconds");
        expect((yield* Fiber.join(running)).reason).toBe("timeout");
        expect(f.closed).toBe(1);
        f.control.wait = false;
        expect((yield* f.service.format({ threadId, answer: "Retry" })).cacheHit).toBe(false);
        expect(f.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("does not fallback on CLI errors or accept another reported model", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.control.exitCode = 1;
      f.control.stderr = "private command failure details";
      const failed = yield* f.service.format({ threadId, answer: "One" }).pipe(Effect.flip);
      expect(failed.reason).toBe("unavailable");
      expect(failed.message).not.toContain(f.control.stderr);
      f.control.exitCode = 0;
      f.control.stderr = "";
      f.control.output = json({ result: json(useful), modelUsage: { "claude-opus-5-5": {} } });
      expect((yield* f.service.format({ threadId, answer: "Two" }).pipe(Effect.flip)).reason).toBe(
        "output",
      );
      expect(f.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});
