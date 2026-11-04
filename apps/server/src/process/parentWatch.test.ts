// @effect-diagnostics nodeBuiltinImport:off - The process-tree test spawns real Node processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ParentWatch from "./parentWatch.ts";

const probe = (state: {
  parentPid: number;
  alive: Set<number>;
}): ParentWatch.ParentProcessProbe => ({
  parentPid: () => state.parentPid,
  exists: (pid) => state.alive.has(pid),
});

describe("parent watch", () => {
  it.effect("waits while the parent lives and completes once the process is reparented", () =>
    Effect.gen(function* () {
      const state = { parentPid: 4242, alive: new Set([4242]) };
      const watch = yield* ParentWatch.awaitParentExit({
        startedUnder: 4242,
        interval: "2 seconds",
        probe: probe(state),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.isUndefined(watch.pollUnsafe());

      // SIGKILL of the desktop app: launchd adopts the backend.
      state.parentPid = 1;
      state.alive.delete(4242);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(watch);
    }),
  );

  it("treats a vanished parent pid or a start under pid 1 as gone", () => {
    // Windows keeps the old ppid after the parent exits.
    assert.isTrue(ParentWatch.isParentGone(4242, probe({ parentPid: 4242, alive: new Set() })));
    assert.isTrue(ParentWatch.isParentGone(1, probe({ parentPid: 1, alive: new Set([1]) })));
    assert.isFalse(
      ParentWatch.isParentGone(4242, probe({ parentPid: 4242, alive: new Set([4242]) })),
    );
  });

  it("stops a child whose parent is SIGKILLed, through its own SIGTERM teardown", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-parent-watch-"));
    const effectUrl = NodeURL.pathToFileURL(
      NodeModule.createRequire(import.meta.filename).resolve("effect/Effect"),
    );
    const moduleUrl = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "parentWatch.ts"));
    // The "backend": watches its parent and, like the server, tears down on SIGTERM.
    const child = NodePath.join(dir, "child.ts");
    NodeFS.writeFileSync(
      child,
      [
        `import * as Effect from ${JSON.stringify(effectUrl.href)};`,
        `import * as ParentWatch from ${JSON.stringify(moduleUrl.href)};`,
        `process.on("SIGTERM", () => { console.log("teardown"); process.exit(0); });`,
        `console.log("watching " + process.pid);`,
        `setInterval(() => {}, 1000);`,
        `await Effect.runPromise(`,
        `  ParentWatch.awaitParentExit({ startedUnder: ParentWatch.parentPidAtStart, interval: "50 millis" }).pipe(`,
        `    Effect.andThen(Effect.sync(() => console.log("parent gone"))),`,
        `    Effect.andThen(ParentWatch.stopThisProcess(5000)),`,
        `  ),`,
        `);`,
      ].join("\n"),
    );
    // The "desktop app": starts the backend, sharing its stdout, then idles.
    const parent = NodePath.join(dir, "parent.mjs");
    NodeFS.writeFileSync(
      parent,
      [
        `import { spawn } from "node:child_process";`,
        `spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", ${JSON.stringify(child)}], {`,
        `  stdio: ["ignore", "inherit", "inherit"],`,
        `});`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );

    const app = NodeChildProcess.spawn(process.execPath, [parent], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    let backendPid: number | null = null;
    try {
      // The pipe ends only when the app and its backend have both exited.
      const closed = new Promise<void>((resolve) => app.stdout.on("end", resolve));
      await new Promise<void>((resolve, reject) => {
        app.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const watching = /watching (\d+)/.exec(output);
          if (watching) {
            backendPid = Number(watching[1]);
            resolve();
          }
        });
        closed.then(() => reject(new Error(`the backend never started: ${output}`)));
      });
      app.kill("SIGKILL");
      await closed;
      assert.match(output, /watching \d+\nparent gone\nteardown\n/);
    } finally {
      app.kill("SIGKILL");
      if (backendPid !== null && ParentWatch.nodeParentProcessProbe.exists(backendPid)) {
        process.kill(backendPid, "SIGKILL");
      }
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
