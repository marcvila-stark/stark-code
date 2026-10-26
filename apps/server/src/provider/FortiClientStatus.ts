// @effect-diagnostics nodeBuiltinImport:off -- bounded local diagnostic speaks only the GUI's read-only GetStatus request
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostProcess from "@starkfuture/shared/HostProcess";

export type FortiClientState = "disconnected" | "running" | "unknown";

type SocketIdentity = {
  readonly uid: number;
  readonly mode: number;
  readonly ino: number;
  readonly dev: number;
  readonly socket: boolean;
};

type Runtime = {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly uid: number | undefined;
  readonly readVersion: () => string | null;
  readonly inspectSocket: (path: string) => SocketIdentity;
  readonly connect: (path: string) => NodeNet.Socket;
};

const MAX_REPLY_BYTES = 8192;
const DEADLINE_MS = 1500;

function installedVersion(): string | null {
  const fd = NodeFS.openSync("/Applications/FortiClient.app/Contents/Info.plist", "r");
  try {
    const data = Buffer.alloc(16_385);
    const length = NodeFS.readSync(fd, data, 0, data.length, 0);
    if (length > 16_384) return null;
    const xml = data.subarray(0, length).toString("utf8");
    if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.fortinet\.FortiClient<\/string>/u.test(xml))
      return null;
    return (
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(xml)?.[1] ?? null
    );
  } finally {
    NodeFS.closeSync(fd);
  }
}

const host: Omit<Runtime, "platform" | "arch"> = {
  uid: process.getuid?.(),
  readVersion: installedVersion,
  inspectSocket: (path) => {
    const info = NodeFS.lstatSync(path);
    return {
      uid: info.uid,
      mode: info.mode,
      ino: info.ino,
      dev: info.dev,
      socket: info.isSocket(),
    };
  },
  connect: (path) => NodeNet.createConnection({ path }),
};

function trustedSocket(info: SocketIdentity, uid: number): boolean {
  return info.socket && info.uid === uid && (info.mode & 0o777) === 0o600;
}

function decodeStatus(data: Buffer): FortiClientState {
  if (data.length < 5 || data[0] !== 32 || data.readUInt32LE(1) !== data.length) return "unknown";
  const seen = new Set<number>();
  let retcode: number | undefined;
  let status: number | undefined;
  let type: number | undefined;
  for (let offset = 5; offset < data.length;) {
    if (data.length - offset < 5) return "unknown";
    const attribute = data[offset]!;
    const length = data.readUInt32LE(offset + 1);
    if (length < 5 || length > data.length - offset || seen.has(attribute)) return "unknown";
    seen.add(attribute);
    const size = length - 5;
    switch (attribute) {
      case 6:
        if (size !== 4) return "unknown";
        retcode = data.readUInt32LE(offset + 5);
        break;
      case 9:
      case 10:
        if (size !== 1) return "unknown";
        if (attribute === 9) status = data[offset + 5];
        else type = data[offset + 5];
        break;
      // Validate but never decode/retain the connection name, account, IP or SAML name.
      case 1:
      case 3:
        if (size > 1024) return "unknown";
        break;
      case 11:
        if (size > 64) return "unknown";
        break;
      case 19:
        if (size > 2047) return "unknown";
        break;
      default:
        return "unknown";
    }
    offset += length;
  }
  if (retcode !== 0 || type === undefined || type > 2) return "unknown";
  // The native status enum is not the renderer enum: 1=off, 2=connecting,
  // 3=connected, 0=authentication. Transitional states must not pause recovery.
  if (status === 1) return "disconnected";
  return status === 3 && (type === 1 || type === 2) ? "running" : "unknown";
}

/**
 * Version-bound adapter for the installed FortiClient GUI's status IPC. The
 * 7.4.3.4323 arm64 addon was traced from getConnectionState -> VPNCmdGetStatus:
 * opcode20, five-byte LE header, response32 and TLVs6/9/10. No native code is
 * loaded and no connection/configuration command is exposed. New versions need
 * protocol verification; scutil Disconnected is not a safe fallback (the GUI
 * can be connected while its NetworkExtension service reports disconnected).
 */
export const readStatus = (runtime: Runtime): Effect.Effect<FortiClientState> =>
  Effect.callback<FortiClientState>((resume) => {
    let socket: NodeNet.Socket | undefined;
    let finished = false;
    const bytes = Buffer.alloc(MAX_REPLY_BYTES);
    let received = 0;
    const cleanup = () => {
      socket?.destroy();
      bytes.fill(0);
    };
    const finish = (state: FortiClientState) => {
      if (finished) return;
      finished = true;
      cleanup();
      resume(Effect.succeed(state));
    };
    try {
      const uid = runtime.uid;
      if (
        runtime.platform !== "darwin" ||
        runtime.arch !== "arm64" ||
        uid === undefined ||
        !Number.isSafeInteger(uid) ||
        uid <= 0 ||
        runtime.readVersion() !== "7.4.3.4323"
      ) {
        finish("unknown");
        return;
      }
      const path = `/tmp/fctvpnctl.sock_${uid}`;
      const before = runtime.inspectSocket(path);
      if (!trustedSocket(before, uid)) {
        finish("unknown");
        return;
      }
      socket = runtime.connect(path);
      socket.once("connect", () => {
        try {
          const after = runtime.inspectSocket(path);
          if (!trustedSocket(after, uid) || before.ino !== after.ino || before.dev !== after.dev) {
            finish("unknown");
            return;
          }
          // Sole request; it has no attributes and cannot change VPN state.
          socket?.write(Buffer.from([20, 5, 0, 0, 0]));
        } catch {
          finish("unknown");
        }
      });
      socket.on("data", (chunk: Buffer) => {
        if (finished) return;
        if (received + chunk.length > MAX_REPLY_BYTES) return finish("unknown");
        chunk.copy(bytes, received);
        received += chunk.length;
        if (received < 5) return;
        const length = bytes.readUInt32LE(1);
        if (bytes[0] !== 32 || length < 5 || length > MAX_REPLY_BYTES || received > length)
          return finish("unknown");
        if (received === length) finish(decodeStatus(bytes.subarray(0, received)));
      });
      socket.once("error", () => finish("unknown"));
      socket.once("end", () => finish("unknown"));
      socket.once("close", () => finish("unknown"));
    } catch {
      finish("unknown");
    }
    return Effect.sync(() => {
      finished = true;
      cleanup();
    });
  }).pipe(
    Effect.timeoutOption(DEADLINE_MS),
    Effect.map(Option.getOrElse(() => "unknown" as const)),
  );

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  return () => readStatus({ ...host, platform, arch });
});
