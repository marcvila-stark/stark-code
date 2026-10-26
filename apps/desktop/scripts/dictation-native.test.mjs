import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { buildDictation, dictationArchitectures } from "./build-dictation.mjs";

// oxlint-disable-next-line starkcode/no-global-process-runtime -- This test compiles a native helper for the actual host.
const hostPlatform = process.platform;

describe.skipIf(hostPlatform !== "darwin")("bundled on-device dictation helper", () => {
  let directory;
  let bundle;
  let executable;
  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-dictation-test-"));
    bundle = NodePath.join(directory, "Stark Dictation.app");
    buildDictation({ arch: "universal", output: bundle });
    executable = NodePath.join(bundle, "Contents/MacOS/stark-dictation");
  }, 60_000);
  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("ships a signed executable for both Mac architectures with microphone entitlement", () => {
    const architectures = NodeChildProcess.execFileSync("lipo", ["-archs", executable], {
      encoding: "utf8",
    });
    expect(architectures).toContain("arm64");
    expect(architectures).toContain("x86_64");
    NodeChildProcess.execFileSync("codesign", ["--verify", "--strict", bundle]);
    const signature = NodeChildProcess.spawnSync(
      "codesign",
      ["--display", "--entitlements", "-", bundle],
      { encoding: "utf8" },
    );
    expect(signature.status).toBe(0);
    expect(signature.stdout + signature.stderr).toContain("com.apple.security.device.audio-input");
    const plist = NodeChildProcess.execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", NodePath.join(bundle, "Contents/Info.plist")],
      { encoding: "utf8" },
    );
    expect(JSON.parse(plist).NSSpeechRecognitionUsageDescription).toContain("on this Mac");
  });

  it("can inspect local language support without starting a microphone or permission request", () => {
    const result = NodeChildProcess.spawnSync(executable, ["--check", "--locale", "en-US"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ supported: expect.any(Boolean), locale: "en-US" });
  });

  it("relays the capability check through a separately launched Mac application", () => {
    const result = NodeChildProcess.spawnSync(
      executable,
      ["--launch", "--check", "--locale", "en-US"],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ supported: expect.any(Boolean), locale: "en-US" });
  }, 25_000);

  it.each(["stop", "cancel", "eof", "signal"])(
    "releases the launched worker on %s without recording audio",
    async (action) => {
      const child = NodeChildProcess.spawn(executable, ["--launch", "--transport-check"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closed = NodeEvents.once(child, "close");
      let buffer = "";
      const events = [];
      let workerPID;
      let started = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        buffer += text;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const event = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          events.push(event);
          if (event.type !== "ready" || started) continue;
          started = true;
          workerPID = event.pid;
          if (action === "eof") child.stdin.end();
          else if (action === "signal") child.kill("SIGTERM");
          else child.stdin.write(JSON.stringify({ type: action }) + "\n");
        }
      });
      try {
        const [code] = await closed;
        expect(code).toBe(0);
        expect(started).toBe(true);
        expect(workerPID).not.toBe(child.pid);
        expect(events.some((event) => event.type === "cancelled")).toBe(true);
        // The broker waits for its exact NSRunningApplication to terminate.
        // A successful close must not leave a worker holding any resources.
        expect(() => process.kill(workerPID, 0)).toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
    },
    20_000,
  );

  it("cancels during launch without allowing the worker to become ready", () => {
    const result = NodeChildProcess.spawnSync(executable, ["--launch", "--transport-check"], {
      encoding: "utf8",
      input: "",
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([{ type: "cancelled" }]);
  }, 25_000);

  it("rejects invalid commands before it could request microphone access", () => {
    const result = NodeChildProcess.spawnSync(executable, ["--invalid"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stdout).type).toBe("error");
    expect(() => dictationArchitectures("invalid")).toThrow("Unsupported");
  });

  it.each([
    { name: "without arguments", args: [] },
    { name: "with only a locale", args: ["--locale", "en-US"] },
  ])("rejects direct recording launches $name before requesting permissions", ({ args }) => {
    const result = NodeChildProcess.spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "error",
      message: "Start dictation from Stark Code.",
    });
  });
});
