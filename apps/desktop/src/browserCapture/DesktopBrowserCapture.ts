// @effect-diagnostics nodeBuiltinImport:off -- Native Messaging uses an authenticated, profile-local Unix socket and atomic private files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import {
  BROWSER_CAPTURE_HOST,
  BrowserCaptureExtensionId,
  type BrowserCaptureDesktopCommand,
  type BrowserCaptureDesktopResult,
} from "@starkfuture/contracts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { BrowserCaptureInbox, writeBrowserCaptureJson } from "./BrowserCaptureInbox.ts";

const isExtensionId = Schema.is(BrowserCaptureExtensionId);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class BrowserCaptureHost {
  readonly inbox: BrowserCaptureInbox;
  readonly runtimeDirectory: string;
  private server: NodeNet.Server | null = null;
  private socketDirectory: string | null = null;
  private readonly clients = new Set<NodeNet.Socket>();
  private readonly listeners = new Set<() => void>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private extensionId: string | undefined;
  private readonly configPath: string;
  private readonly launcherPath: string;
  private readonly manifestPath: string;
  private readonly options: {
    directory: string;
    homeDirectory: string;
    executable: string;
    helper: string;
    platform: NodeJS.Platform;
    packaged: boolean;
    reveal?: () => Promise<void>;
  };
  constructor(options: {
    directory: string;
    homeDirectory: string;
    executable: string;
    helper: string;
    platform: NodeJS.Platform;
    packaged: boolean;
    reveal?: () => Promise<void>;
  }) {
    this.options = options;
    this.inbox = new BrowserCaptureInbox(NodePath.join(options.directory, "inbox.json"));
    // Chrome cannot launch helpers from a custom Stark home in Documents/Desktop
    // without macOS folder access. Only connection files live here; inbox data
    // stays in the chosen profile, and the hash keeps each profile's capability separate.
    this.runtimeDirectory = NodePath.join(
      options.homeDirectory,
      "Library/Application Support/Stark Code/BrowserCaptureHosts",
      NodeCrypto.createHash("sha256").update(NodePath.resolve(options.directory)).digest("hex"),
    );
    this.configPath = NodePath.join(this.runtimeDirectory, "host.json");
    this.launcherPath = NodePath.join(this.runtimeDirectory, "native-host");
    this.manifestPath = NodePath.join(
      options.homeDirectory,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${BROWSER_CAPTURE_HOST}.json`,
    );
  }
  onPending(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
  private changeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }
  async initialize() {
    await this.inbox.load();
    try {
      const raw = await NodeFSP.readFile(this.configPath, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return NodeFSP.readFile(NodePath.join(this.options.directory, "host.json"), "utf8");
      });
      const stored: unknown = JSON.parse(raw);
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("extensionId" in stored) ||
        !isExtensionId(stored.extensionId)
      )
        throw new Error(
          "The browser capture connection could not be read. Reconnect it in Settings.",
        );
      const manifest: unknown = JSON.parse(await NodeFSP.readFile(this.manifestPath, "utf8"));
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("name" in manifest) ||
        manifest.name !== BROWSER_CAPTURE_HOST ||
        !("type" in manifest) ||
        manifest.type !== "stdio" ||
        !("path" in manifest) ||
        (manifest.path !== this.launcherPath &&
          manifest.path !== NodePath.join(this.options.directory, "native-host")) ||
        !("allowed_origins" in manifest) ||
        !Array.isArray(manifest.allowed_origins) ||
        manifest.allowed_origins.length !== 1 ||
        manifest.allowed_origins[0] !== `chrome-extension://${stored.extensionId}/`
      )
        return;
      if (manifest.path === this.launcherPath) await this.start(stored.extensionId);
      else await this.connectNow(stored.extensionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  status(): BrowserCaptureDesktopResult {
    return {
      connected: this.server !== null,
      ...(this.extensionId ? { extensionId: this.extensionId } : {}),
    };
  }
  private async start(extensionId: string) {
    if (this.server) await this.stop();
    if (this.options.platform !== "darwin")
      throw new Error("Browser capture preview currently supports desktop Chrome on macOS.");
    this.socketDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-clip-"));
    await NodeFSP.chmod(this.socketDirectory, 0o700);
    const socketPath = NodePath.join(this.socketDirectory, "host.sock");
    const capability = NodeCrypto.randomBytes(32).toString("hex");
    const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
      this.clients.add(socket);
      socket.once("close", () => this.clients.delete(socket));
      let bytes = Buffer.alloc(0),
        handled = false;
      socket.setTimeout(15_000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        if (handled) return;
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 8 * 1024 * 1024) {
          handled = true;
          socket.destroy();
          return;
        }
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        handled = true;
        void (async () => {
          try {
            const envelope: unknown = JSON.parse(bytes.subarray(0, newline).toString());
            if (
              typeof envelope !== "object" ||
              envelope === null ||
              !("capability" in envelope) ||
              typeof envelope.capability !== "string" ||
              !/^[a-f0-9]{64}$/.test(envelope.capability) ||
              !NodeCrypto.timingSafeEqual(
                Buffer.from(envelope.capability),
                Buffer.from(capability),
              ) ||
              !("message" in envelope)
            )
              throw new Error("Browser connection was rejected.");
            const result = await this.nativeRequest(envelope.message);
            socket.end(JSON.stringify({ ok: true, result }) + "\n");
          } catch (error) {
            socket.end(
              JSON.stringify({
                ok: false,
                error:
                  error instanceof SyntaxError
                    ? "Invalid browser capture request."
                    : error instanceof Error
                      ? error.message
                      : "Capture failed.",
              }) + "\n",
            );
          }
        })();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      await NodeFSP.chmod(socketPath, 0o600);
      this.server = server;
      this.extensionId = extensionId;
      await writeBrowserCaptureJson(this.configPath, {
        extensionId,
        origin: `chrome-extension://${extensionId}/`,
        socket: socketPath,
        capability,
        ...(this.options.packaged ? { appExecutable: this.options.executable } : {}),
      });
    } catch (error) {
      this.server = server;
      await this.stop();
      this.extensionId = undefined;
      throw error;
    }
  }
  private async nativeRequest(raw: unknown): Promise<unknown> {
    if (typeof raw !== "object" || raw === null || !("method" in raw))
      throw new Error("Invalid browser capture request.");
    switch (raw.method) {
      case "open":
        if (!this.options.reveal) throw new Error("Open Stark, then retry this capture.");
        await this.options.reveal();
        return { opened: true };
      case "catalog": {
        const catalog = this.inbox.getCatalog();
        if (Buffer.byteLength(JSON.stringify({ ok: true, result: catalog })) > 1024 * 1024 - 4)
          throw new Error(
            "The chat list is too large to send to Chrome. Your capture is safe; reduce the available chat list and retry.",
          );
        return catalog;
      }
      case "deliver": {
        if (!("delivery" in raw)) throw new Error("Missing capture.");
        const receipt = await this.inbox.submit(raw.delivery);
        this.notify();
        return receipt;
      }
      case "receipt":
      case "discard": {
        if (!("id" in raw) || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id))
          throw new Error("Invalid capture id.");
        if (raw.method === "receipt") return this.inbox.getReceipt(raw.id);
        const receipt = await this.inbox.discard(raw.id);
        this.notify();
        return receipt;
      }
      default:
        throw new Error("This browser connection only accepts capture operations.");
    }
  }
  connect(extensionId: string) {
    return this.changeLifecycle(() => this.connectNow(extensionId));
  }
  private async connectNow(extensionId: string) {
    if (!isExtensionId(extensionId))
      throw new Error("Enter the extension ID shown in Chrome’s extension details.");
    if (this.options.platform !== "darwin")
      throw new Error("The browser capture preview supports macOS Chrome first.");
    try {
      const existing: unknown = JSON.parse(await NodeFSP.readFile(this.manifestPath, "utf8"));
      if (
        typeof existing !== "object" ||
        existing === null ||
        !("path" in existing) ||
        (existing.path !== this.launcherPath &&
          existing.path !== NodePath.join(this.options.directory, "native-host"))
      )
        throw new Error("Chrome is connected to another Stark profile. Disconnect it there first.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await NodeFSP.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    await NodeFSP.chmod(this.runtimeDirectory, 0o700);
    const helper = NodePath.join(this.runtimeDirectory, "host.cjs");
    await NodeFSP.copyFile(this.options.helper, helper);
    await NodeFSP.chmod(helper, 0o600);
    const launcher = `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(this.options.executable)} ${shellQuote(helper)} ${shellQuote(this.configPath)} "$@"\n`;
    await NodeFSP.writeFile(this.launcherPath, launcher, { mode: 0o700 });
    await NodeFSP.chmod(this.launcherPath, 0o700);
    try {
      await this.start(extensionId);
      await writeBrowserCaptureJson(this.manifestPath, {
        name: BROWSER_CAPTURE_HOST,
        description: "Add browser captures to the selected Stark Code profile",
        path: this.launcherPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      });
      await NodeFSP.rm(NodePath.join(this.options.directory, "host.json"), { force: true });
    } catch (error) {
      await this.stop();
      this.extensionId = undefined;
      await NodeFSP.rm(this.configPath, { force: true });
      throw error;
    }
    this.notify();
  }
  async stop() {
    const server = this.server;
    this.server = null;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.socketDirectory)
      await NodeFSP.rm(this.socketDirectory, { recursive: true, force: true });
    this.socketDirectory = null;
  }
  disconnect() {
    return this.changeLifecycle(() => this.disconnectNow());
  }
  private async disconnectNow() {
    await this.stop();
    this.extensionId = undefined;
    try {
      const manifest = JSON.parse(await NodeFSP.readFile(this.manifestPath, "utf8"));
      if (manifest.path === this.launcherPath) await NodeFSP.rm(this.manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await NodeFSP.rm(this.configPath, { force: true });
    this.notify();
  }
  async command(command: BrowserCaptureDesktopCommand): Promise<BrowserCaptureDesktopResult> {
    switch (command.action) {
      case "connect":
        await this.connect(command.extensionId);
        break;
      case "disconnect":
        await this.disconnect();
        break;
      case "publish":
        this.inbox.publish(command.catalog);
        break;
      case "pending":
        return {
          ...this.status(),
          pending: this.server ? await this.inbox.takePending(command.environmentIds) : [],
        };
      case "complete":
        await this.inbox.complete(command.receipt);
        break;
      case "status":
        break;
    }
    return this.status();
  }
}

export class BrowserCaptureError extends Schema.TaggedError<BrowserCaptureError>()(
  "BrowserCaptureError",
  { message: Schema.String },
) {}
export class DesktopBrowserCapture extends Context.Service<
  DesktopBrowserCapture,
  {
    readonly initialize: Effect.Effect<void, BrowserCaptureError>;
    readonly subscribePending: (
      listener: () => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly command: (
      input: BrowserCaptureDesktopCommand,
    ) => Effect.Effect<BrowserCaptureDesktopResult, BrowserCaptureError>;
  }
>()("@starkfuture/desktop/browserCapture/DesktopBrowserCapture") {}

export const layer = Layer.effect(
  DesktopBrowserCapture,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const executable = yield* HostProcess.ExecutablePath;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<never>();
    const runListener = Effect.runPromiseWith(context);
    const host = new BrowserCaptureHost({
      directory: environment.path.join(environment.stateDir, "browser-capture"),
      homeDirectory: environment.homeDirectory,
      executable,
      helper: environment.isPackaged
        ? environment.path.join(environment.resourcesPath, "browser-capture-host.cjs")
        : environment.path.join(
            environment.rootDir,
            "apps/desktop/resources/browser-capture-host.cjs",
          ),
      platform: environment.platform,
      packaged: environment.isPackaged,
      reveal: () =>
        runListener(
          Effect.gen(function* () {
            const main = yield* electronWindow.main;
            if (Option.isNone(main))
              return yield* new BrowserCaptureError({
                message: "Open the Stark desktop window, then retry.",
              });
            yield* electronWindow.reveal(main.value);
          }),
        ),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => host.stop()));
    const run = <T>(operation: () => Promise<T>) =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new BrowserCaptureError({
            message:
              error instanceof SyntaxError
                ? "The browser capture connection could not be read. Reconnect it in Settings."
                : error instanceof Error
                  ? error.message
                  : "Browser capture failed.",
          }),
      });
    return DesktopBrowserCapture.of({
      initialize: run(() => host.initialize()),
      subscribePending: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            host.onPending(() => {
              void runListener(listener()).catch(() => undefined);
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ).pipe(Effect.asVoid),
      command: (input) => run(() => host.command(input)),
    });
  }),
);
