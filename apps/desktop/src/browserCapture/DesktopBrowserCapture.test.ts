// @effect-diagnostics nodeBuiltinImport:off -- Native-host tests use actual stdio framing and private temporary sockets, never installed browser profiles.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { BrowserCaptureDelivery } from "@starkfuture/contracts";
import { BrowserCaptureHost } from "./DesktopBrowserCapture.ts";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const origin = `chrome-extension://${extensionId}/`;
const helper = NodeURL.fileURLToPath(
  new URL("../../resources/browser-capture-host.cjs", import.meta.url),
);
const directories: string[] = [],
  hosts: BrowserCaptureHost[] = [];
const target = {
  kind: "thread",
  environmentId: "environment",
  projectId: "project",
  threadId: "thread",
} as const;
const item: BrowserCaptureDelivery = {
  capture: {
    version: 1,
    id: "capture",
    kind: "text",
    pageUrl: "https://example.com",
    pageTitle: "Example",
    capturedAt: "2026-11-02T00:00:00.000Z",
    text: "Exact Unicode quote: café 👋",
    note: "Compare",
  },
  target,
};
const catalog = {
  destinations: [
    {
      target,
      label: "A chat",
      projectLabel: "A project",
      environmentLabel: "This Mac",
      current: true,
    },
  ],
  projects: [
    {
      environmentId: "environment",
      projectId: "project",
      label: "A project",
      environmentLabel: "This Mac",
    },
  ],
};
async function fixture(reveal?: () => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-host-test-"));
  directories.push(directory);
  const options = {
    directory: NodePath.join(directory, "profile with a ' quote"),
    homeDirectory: NodePath.join(directory, "home"),
    executable: process.execPath,
    helper,
    platform: "darwin" as const,
    packaged: false,
    ...(reveal ? { reveal } : {}),
  };
  const host = new BrowserCaptureHost(options);
  hosts.push(host);
  await host.initialize();
  return {
    directory,
    options,
    host,
    configPath: NodePath.join(host.runtimeDirectory, "host.json"),
    manifestPath: NodePath.join(
      options.homeDirectory,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.starkcode.capture.json",
    ),
  };
}
function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function parseFrames(buffer: Buffer): unknown[] {
  const values: unknown[] = [];
  while (buffer.length) {
    if (buffer.length < 4) throw new Error("Incomplete native header");
    const size = buffer.readUInt32LE(0);
    if (buffer.length < size + 4) throw new Error("Incomplete native payload");
    values.push(JSON.parse(buffer.subarray(4, size + 4).toString()));
    buffer = buffer.subarray(size + 4);
  }
  return values;
}
async function native(configPath: string, input: Buffer, sender = origin, launcher?: string) {
  const child = NodeChildProcess.spawn(
    launcher ?? process.execPath,
    launcher ? [sender] : [helper, configPath, sender],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const out: Buffer[] = [],
    err: Buffer[] = [];
  child.stdout.on("data", (bytes) => out.push(bytes));
  child.stderr.on("data", (bytes) => err.push(bytes));
  const result = NodeEvents.EventEmitter.once(child, "close");
  child.stdin.on("error", () => {});
  child.stdin.write(input.subarray(0, 2));
  child.stdin.end(input.subarray(2));
  const [code] = await result;
  return { code, frames: parseFrames(Buffer.concat(out)), stderr: Buffer.concat(err).toString() };
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("profile-scoped browser Native Messaging host", () => {
  it("keeps browser-launched files outside the profile's potentially protected data folder", async () => {
    const { host, options, manifestPath } = await fixture();
    await host.connect(extensionId);
    const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    expect(manifest.path.startsWith(options.directory + NodePath.sep)).toBe(false);
    expect(
      manifest.path.startsWith(NodePath.join(options.homeDirectory, "Library") + NodePath.sep),
    ).toBe(true);
    expect((await NodeFSP.stat(NodePath.dirname(manifest.path))).mode & 0o777).toBe(0o700);
  });
  it("pairs only the requested origin and forwards real framed messages to a durable inbox", async () => {
    const { host, configPath, manifestPath } = await fixture();
    await host.connect(extensionId);
    host.inbox.publish(catalog);
    const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    expect(manifest.allowed_origins).toEqual([origin]);
    expect(manifest.type).toBe("stdio");
    const response = await native(
      configPath,
      Buffer.concat([frame({ method: "catalog" }), frame({ method: "deliver", delivery: item })]),
      origin,
      manifest.path,
    );
    expect(response.code).toBe(0);
    expect(response.stderr).toBe("");
    expect(response.frames).toEqual([
      { ok: true, result: catalog },
      {
        ok: true,
        result: {
          id: "capture",
          state: "pending",
          message: "Waiting for the selected chat draft.",
        },
      },
    ]);
    expect((await host.command({ action: "pending" })).pending).toEqual([item]);
    await host.command({
      action: "complete",
      receipt: { id: "capture", state: "saved", message: "Saved to A chat" },
    });
    const saved = await native(configPath, frame({ method: "receipt", id: "capture" }));
    expect(saved.frames).toEqual([
      { ok: true, result: { id: "capture", state: "saved", message: "Saved to A chat" } },
    ]);
  });
  it("opens the connected feature window only on the explicit open action", async () => {
    let opened = 0;
    const { host, configPath } = await fixture(async () => {
      opened++;
    });
    await host.connect(extensionId);
    host.inbox.publish(catalog);
    await native(configPath, frame({ method: "deliver", delivery: item }));
    expect(opened).toBe(0);
    expect((await native(configPath, frame({ method: "open" }))).frames).toEqual([
      { ok: true, result: { opened: true } },
    ]);
    expect(opened).toBe(1);
  });
  it("rejects another extension and unscoped commands without mutating the inbox", async () => {
    const { host, configPath } = await fixture();
    await host.connect(extensionId);
    host.inbox.publish(catalog);
    const wrong = await native(
      configPath,
      frame({ method: "deliver", delivery: item }),
      "chrome-extension://pppppppppppppppppppppppppppppppp/",
    );
    expect(wrong.code).toBe(1);
    expect(wrong.frames).toEqual([
      { ok: false, error: "This Chrome extension is not connected to this Stark profile." },
    ]);
    const execute = await native(
      configPath,
      frame({ method: "execute", command: "must not execute" }),
    );
    expect(execute.frames).toEqual([
      { ok: false, error: "This browser connection only accepts capture operations." },
    ]);
    expect(host.inbox.listPending()).toEqual([]);
  });
  it("rejects a wrong socket capability and malformed frames", async () => {
    const { host, configPath } = await fixture();
    await host.connect(extensionId);
    const config = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
    const socket = NodeNet.createConnection(config.socket);
    const response: Buffer[] = [];
    socket.on("data", (bytes) => response.push(bytes));
    const ended = NodeEvents.EventEmitter.once(socket, "end");
    await NodeEvents.EventEmitter.once(socket, "connect");
    socket.end(
      JSON.stringify({ capability: "0".repeat(64), message: { method: "catalog" } }) + "\n",
    );
    await ended;
    expect(JSON.parse(Buffer.concat(response).toString())).toEqual({
      ok: false,
      error: "Browser connection was rejected.",
    });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(8 * 1024 * 1024 + 1);
    expect((await native(configPath, header)).frames).toEqual([
      { ok: false, error: "Capture exceeds the size limit." },
    ]);
    expect((await native(configPath, frame({ method: "catalog" }).subarray(0, 7))).frames).toEqual([
      { ok: false, error: "Incomplete native message." },
    ]);
  });
  it("refuses cancel while claimed and deletes only unclaimed pending data", async () => {
    const { host, configPath } = await fixture();
    await host.connect(extensionId);
    host.inbox.publish(catalog);
    await native(configPath, frame({ method: "deliver", delivery: item }));
    await host.command({ action: "pending" });
    const busy = await native(configPath, frame({ method: "discard", id: "capture" }));
    expect(busy.frames).toEqual([
      {
        ok: true,
        result: {
          id: "capture",
          state: "pending",
          message:
            "Stark is saving this capture. Wait for its receipt before changing the destination.",
        },
      },
    ]);
    await host.command({
      action: "complete",
      receipt: { id: "capture", state: "error", message: "Draft full" },
    });
    expect((await native(configPath, frame({ method: "discard", id: "capture" }))).frames).toEqual([
      {
        ok: true,
        result: { id: "capture", state: "discarded", message: "Pending capture deleted." },
      },
    ]);
    expect(host.inbox.listPending()).toEqual([]);
  });
  it("returns a clear error instead of exceeding Chrome’s native response byte limit", async () => {
    const { host, configPath } = await fixture();
    await host.connect(extensionId);
    const long = "界".repeat(200);
    host.inbox.publish({
      destinations: Array.from({ length: 500 }, (_, index) => ({
        target: { ...target, threadId: String(index).padEnd(128, "x") },
        label: long,
        projectLabel: long,
        environmentLabel: long,
        current: index === 0,
      })),
      projects: Array.from({ length: 200 }, (_, index) => ({
        environmentId: "environment",
        projectId: String(index).padEnd(128, "x"),
        label: long,
        environmentLabel: long,
      })),
    });
    expect((await native(configPath, frame({ method: "catalog" }))).frames).toEqual([
      {
        ok: false,
        error:
          "The chat list is too large to send to Chrome. Your capture is safe; reduce the available chat list and retry.",
      },
    ]);
  });
  it("does not replace another profile's host registration", async () => {
    const { host, options, manifestPath } = await fixture();
    await host.connect(extensionId);
    const before = await NodeFSP.readFile(manifestPath, "utf8");
    const other = new BrowserCaptureHost({
      ...options,
      directory: NodePath.join(options.directory, "other"),
    });
    hosts.push(other);
    await expect(other.connect(extensionId)).rejects.toThrow("another Stark profile");
    expect(await NodeFSP.readFile(manifestPath, "utf8")).toBe(before);
    expect(other.status().connected).toBe(false);
  });
  it("restores its own registration after restart and disconnects without losing pending bytes", async () => {
    const { host, options, configPath, manifestPath } = await fixture();
    await host.connect(extensionId);
    host.inbox.publish(catalog);
    await host.inbox.submit(item);
    await host.stop();
    const restored = new BrowserCaptureHost(options);
    hosts.push(restored);
    await restored.initialize();
    expect(restored.status().connected).toBe(true);
    expect((await restored.command({ action: "pending" })).pending).toEqual([item]);
    await restored.disconnect();
    expect(restored.status().connected).toBe(false);
    expect((await restored.command({ action: "pending" })).pending).toEqual([]);
    await expect(NodeFSP.access(configPath)).rejects.toThrow();
    await expect(NodeFSP.access(manifestPath)).rejects.toThrow();
    expect(restored.inbox.listPending()).toEqual([item]);
  });
  it("migrates its own earlier registration while retaining pending captures", async () => {
    const { host, options, configPath, manifestPath } = await fixture();
    await host.connect(extensionId);
    host.inbox.publish(catalog);
    await host.inbox.submit(item);
    const legacyConfig = NodePath.join(options.directory, "host.json");
    const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    await NodeFSP.copyFile(configPath, legacyConfig);
    await NodeFSP.rm(configPath);
    await NodeFSP.writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        path: NodePath.join(options.directory, "native-host"),
      }),
    );
    await host.stop();

    const restored = new BrowserCaptureHost(options);
    hosts.push(restored);
    await restored.initialize();
    restored.inbox.publish(catalog);
    expect(restored.status().connected).toBe(true);
    expect((await restored.command({ action: "pending" })).pending).toEqual([item]);
    const migrated = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    expect(migrated.path).toBe(manifest.path);
    expect((await NodeFSP.stat(configPath)).mode & 0o777).toBe(0o600);
    expect(
      (await native(configPath, frame({ method: "catalog" }), origin, migrated.path)).frames,
    ).toEqual([{ ok: true, result: catalog }]);
    await expect(NodeFSP.access(legacyConfig)).rejects.toThrow();
  });
  it("destroys incomplete owned client sockets on stop", async () => {
    const { host, configPath } = await fixture();
    await host.connect(extensionId);
    const config = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
    const socket = NodeNet.createConnection(config.socket);
    const closed = NodeEvents.EventEmitter.once(socket, "close");
    await NodeEvents.EventEmitter.once(socket, "connect");
    socket.write("{");
    await host.stop();
    await closed;
    expect(host.status().connected).toBe(false);
  });
});
