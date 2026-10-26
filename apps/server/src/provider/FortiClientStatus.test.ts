// @effect-diagnostics nodeBuiltinImport:off -- disposable Unix sockets verify the host diagnostic without touching FortiClient
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { readStatus } from "./FortiClientStatus.ts";

type Runtime = NonNullable<Parameters<typeof readStatus>[0]>;

function attribute(type: number, payload: Buffer) {
  const result = Buffer.alloc(5 + payload.length);
  result[0] = type;
  result.writeUInt32LE(result.length, 1);
  payload.copy(result, 5);
  return result;
}

function response(status: number, type = 1, extras: Buffer[] = []) {
  const body = Buffer.concat([
    attribute(6, Buffer.alloc(4)),
    attribute(10, Buffer.from([type])),
    attribute(9, Buffer.from([status])),
    ...extras,
  ]);
  const header = Buffer.from([32, 0, 0, 0, 0]);
  header.writeUInt32LE(body.length + 5, 1);
  return Buffer.concat([header, body]);
}

async function fixture(reply: (socket: NodeNet.Socket) => void) {
  const root = NodeFS.mkdtempSync("/tmp/forti-status-");
  const path = NodePath.join(root, "status.sock");
  const requests: Buffer[] = [];
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (data) => {
      requests.push(Buffer.from(data));
      reply(socket);
    });
  });
  server.listen(path);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  NodeFS.chmodSync(path, 0o600);
  const uid = process.getuid?.() || 501;
  const paths: string[] = [];
  const runtime: Runtime = {
    platform: "darwin",
    arch: "arm64",
    uid,
    readVersion: () => "7.4.3.4323",
    inspectSocket: (requestedPath) => {
      paths.push(requestedPath);
      const stat = NodeFS.lstatSync(path);
      return { uid, mode: stat.mode, ino: stat.ino, dev: stat.dev, socket: stat.isSocket() };
    },
    connect: (requestedPath) => {
      paths.push(requestedPath);
      return NodeNet.createConnection({ path });
    },
  };
  return {
    runtime,
    requests,
    paths,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("FortiClient read-only status boundary", () => {
  it.effect(
    "reads a fragmented GUI status reply, returning no account or connection metadata",
    () =>
      Effect.gen(function* () {
        const data = response(3, 1, [
          attribute(1, Buffer.from("private connection")),
          attribute(3, Buffer.from("private account")),
          attribute(11, Buffer.from("10.0.0.1")),
          attribute(19, Buffer.alloc(0)),
        ]);
        const host = yield* Effect.promise(() =>
          fixture((socket) => {
            socket.write(data.subarray(0, 2));
            setImmediate(() => {
              socket.write(data.subarray(2, 7));
              setImmediate(() => socket.write(data.subarray(7)));
            });
          }),
        );
        try {
          expect(yield* readStatus(host.runtime)).toBe("running");
          expect(host.requests).toEqual([Buffer.from([20, 5, 0, 0, 0])]);
          expect(host.paths).toEqual(Array(3).fill(`/tmp/fctvpnctl.sock_${host.runtime.uid}`));
        } finally {
          yield* Effect.promise(host.close);
        }
      }),
  );

  it.effect("distinguishes confirmed off/connected from transitional and unsupported states", () =>
    Effect.gen(function* () {
      for (const [status, type, expected] of [
        [1, 0, "disconnected"],
        [1, 1, "disconnected"],
        [3, 2, "running"],
        [0, 1, "unknown"],
        [2, 1, "unknown"],
        [4, 1, "unknown"],
        [255, 1, "unknown"],
        [3, 0, "unknown"],
        [1, 3, "unknown"],
      ] as const) {
        const host = yield* Effect.promise(() =>
          fixture((socket) => socket.end(response(status, type))),
        );
        try {
          expect(yield* readStatus(host.runtime)).toBe(expected);
        } finally {
          yield* Effect.promise(host.close);
        }
      }
    }),
  );

  it.effect("rejects unsupported versions, architectures and UIDs before touching the socket", () =>
    Effect.gen(function* () {
      const base: Runtime = {
        platform: "darwin",
        arch: "arm64",
        uid: 501,
        readVersion: () => "7.4.3.4323",
        inspectSocket: () => {
          throw new Error("must not inspect");
        },
        connect: () => {
          throw new Error("must not connect");
        },
      };
      let touched = false;
      const inspect = () => {
        touched = true;
        return base.inspectSocket("");
      };
      const connect = () => {
        touched = true;
        return base.connect("");
      };
      for (const override of [
        { platform: "linux" as const },
        { arch: "x64" },
        { uid: 0 },
        { uid: undefined },
        { uid: -1 },
        { uid: 1.5 },
        { readVersion: () => "7.4.4.0000" },
        { readVersion: () => null },
      ])
        expect(yield* readStatus({ ...base, inspectSocket: inspect, connect, ...override })).toBe(
          "unknown",
        );
      expect(touched).toBe(false);
    }),
  );

  it.effect(
    "refuses other-user, shared, symlink and swapped socket identities without sending",
    () =>
      Effect.gen(function* () {
        for (const override of [{ uid: 502 }, { mode: 0o666 }, { socket: false }, { ino: 44 }]) {
          const host = yield* Effect.promise(() =>
            fixture(() => {
              throw new Error("must not send");
            }),
          );
          let observations = 0;
          try {
            const inspect = host.runtime.inspectSocket;
            expect(
              yield* readStatus({
                ...host.runtime,
                inspectSocket: (path) => {
                  const actual = inspect(path);
                  observations++;
                  return "ino" in override && observations === 1
                    ? actual
                    : { ...actual, ...override };
                },
              }),
            ).toBe("unknown");
            expect(host.requests).toEqual([]);
          } finally {
            yield* Effect.promise(host.close);
          }
        }
      }),
  );

  it.effect(
    "rejects malformed, duplicate, incomplete, oversized and unexpected response data",
    () =>
      Effect.gen(function* () {
        const normal = response(3);
        const badLength = Buffer.from(normal);
        badLength.writeUInt32LE(4, 6);
        const oversized = Buffer.from(normal.subarray(0, 5));
        oversized.writeUInt32LE(8193, 1);
        const failed = Buffer.from(normal);
        failed.writeUInt32LE(1, 10);
        const badAttrSize = Buffer.from(normal);
        badAttrSize.writeUInt32LE(8, 6);
        for (const data of [
          Buffer.concat([Buffer.from([31]), normal.subarray(1)]),
          badLength,
          badAttrSize,
          oversized,
          failed,
          normal.subarray(0, normal.length - 1),
          Buffer.concat([normal, Buffer.from([0])]),
          response(3, 1, [attribute(9, Buffer.from([1]))]),
          response(3, 1, [attribute(22, Buffer.alloc(0))]),
          response(3, 1, [attribute(1, Buffer.alloc(1025))]),
          Buffer.from([32, 5, 0, 0, 0]),
        ]) {
          const host = yield* Effect.promise(() => fixture((socket) => socket.end(data)));
          try {
            expect(yield* readStatus(host.runtime)).toBe("unknown");
          } finally {
            yield* Effect.promise(host.close);
          }
        }
      }),
  );

  it.effect("bounds a silent daemon and closes its connection", () =>
    Effect.gen(function* () {
      let requested!: () => void;
      const request = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const host = yield* Effect.promise(() => fixture(() => requested()));
      try {
        const fiber = yield* readStatus(host.runtime).pipe(Effect.forkChild);
        yield* Effect.promise(() => request);
        yield* TestClock.adjust("1500 millis");
        expect(yield* Fiber.join(fiber)).toBe("unknown");
        expect(host.requests).toHaveLength(1);
      } finally {
        yield* Effect.promise(host.close);
      }
    }),
  );

  it.effect("closes a pending status read when its caller is interrupted", () =>
    Effect.gen(function* () {
      let requested!: () => void;
      const request = new Promise<void>((resolve) => {
        requested = resolve;
      });
      let closed: Promise<unknown> | undefined;
      const host = yield* Effect.promise(() =>
        fixture((socket) => {
          closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
          requested();
        }),
      );
      try {
        const fiber = yield* readStatus(host.runtime).pipe(Effect.forkChild);
        yield* Effect.promise(() => request);
        yield* Fiber.interrupt(fiber);
        yield* Effect.promise(() => closed!);
        expect(host.requests).toHaveLength(1);
      } finally {
        yield* Effect.promise(host.close);
      }
    }),
  );
});
