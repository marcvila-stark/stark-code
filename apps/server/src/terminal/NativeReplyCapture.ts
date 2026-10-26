import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Private ephemeral loopback HTTP server; Node owns socket callbacks and shutdown, not an outbound HttpClient.
import * as NodeHttp from "node:http";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@starkfuture/shared/KeyedLock";
import {
  NativeAgentReply,
  NativeTurnEvidence,
  type NativeAgentAttention,
  type TerminalNativeRepliesInput,
} from "@starkfuture/contracts";
import {
  nativeReplyHookCommand,
  nativeReplyHookSource,
  truncateNativeReplyText,
} from "./NativeReplyHook.ts";

const MAX_BODY_BYTES = 1_048_576;
const MAX_HISTORY_BYTES = 2_097_152;
const MAX_REPLIES = 100;
const id = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256));
const StopDelivery = Schema.Struct({
  deliveryId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  hook_event_name: Schema.Literal("Stop"),
  session_id: id,
  turn_id: Schema.NullOr(id),
  last_assistant_message: Schema.String.check(Schema.isNonEmpty()),
  truncated: Schema.optional(Schema.Boolean),
  evidence: Schema.optional(NativeTurnEvidence),
  stop_hook_active: Schema.Boolean,
  occurred_at: Schema.optional(Schema.Int),
  // A subagent completion cannot be attributed to its parent terminal.
  agent_id: Schema.optional(Schema.Null),
});
const AttentionDelivery = Schema.Struct({
  deliveryId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  hook_event_name: Schema.Literals(["Notification", "UserPromptSubmit", "Stop"]),
  session_id: id,
  attention: Schema.Literals(["permission", "question", "clear"]),
  occurred_at: Schema.Int,
});
const decodeDelivery = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([StopDelivery, AttentionDelivery])),
  {
    onExcessProperty: "error",
  },
);
const StoredReplies = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  replies: Schema.Array(NativeAgentReply).check(Schema.isMaxLength(MAX_REPLIES)),
  deliveries: Schema.Array(Schema.String).check(Schema.isMaxLength(400)),
});
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredReplies));
type StoredReplies = typeof StoredReplies.Type;
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredReplies));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class NativeReplyCaptureError extends Schema.TaggedError<NativeReplyCaptureError>()(
  "NativeReplyCaptureError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Native reply capture could not access its local history.";
  }
}
export interface NativeReplyLaunch {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}
interface Binding {
  readonly threadId: string;
  readonly terminalId: string;
  readonly provider: "claude" | "codex";
  expiresAt: number | null;
  attention?: NativeAgentAttention | undefined;
  lastAttentionAt?: number | undefined;
}

export class NativeReplyCapture extends Context.Service<
  NativeReplyCapture,
  {
    readonly bind: (
      input: Pick<Binding, "threadId" | "terminalId" | "provider">,
    ) => Effect.Effect<NativeReplyLaunch, NativeReplyCaptureError>;
    readonly list: (
      input: TerminalNativeRepliesInput,
    ) => Effect.Effect<ReadonlyArray<NativeAgentReply>, NativeReplyCaptureError>;
    readonly retire: (input: TerminalNativeRepliesInput) => Effect.Effect<void>;
    readonly remove: (
      input: TerminalNativeRepliesInput,
    ) => Effect.Effect<void, NativeReplyCaptureError>;
  }
>()("stark-code/terminal/NativeReplyCapture") {}

/** TerminalManager owns this endpoint and closes it with its scope. */
export const make = Effect.fn("NativeReplyCapture.make")(function* (input: {
  readonly directory: string;
  readonly nodeExecutable: string;
  readonly platform: NodeJS.Platform;
  readonly onReply: (
    reply: NativeAgentReply,
    retained: ReadonlyArray<NativeAgentReply>,
  ) => Effect.Effect<void>;
  readonly onAttention?: (
    target: Pick<Binding, "threadId" | "terminalId">,
    attention: NativeAgentAttention | null,
  ) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const crypto = yield* Crypto.Crypto;
  const digest = (value: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  const bindings = new Map<string, Binding>();
  const documentPath = (threadId: string) =>
    digest(threadId).pipe(Effect.map((hash) => path.join(input.directory, `${hash}.json`)));
  const matches = (binding: Binding, filter: TerminalNativeRepliesInput) =>
    binding.threadId === filter.threadId &&
    (filter.terminalId === undefined || binding.terminalId === filter.terminalId);
  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new NativeReplyCaptureError({ cause })));
  const load = Effect.fn("NativeReplyCapture.load")(function* (threadId: string) {
    const filename = yield* documentPath(threadId);
    if (!(yield* fs.exists(filename)))
      return { version: 1, sequence: 0, replies: [], deliveries: [] } satisfies StoredReplies;
    const stat = yield* fs.stat(filename);
    if (stat.type !== "File" || stat.size > BigInt(MAX_HISTORY_BYTES))
      return yield* new NativeReplyCaptureError({ cause: "Invalid native reply history." });
    const value = yield* decodeStored(yield* fs.readFileString(filename));
    if (value.replies.some((reply) => reply.threadId !== threadId))
      return yield* new NativeReplyCaptureError({ cause: "Misbound native reply history." });
    return value;
  });
  const save = Effect.fn("NativeReplyCapture.save")(function* (
    threadId: string,
    value: StoredReplies,
  ) {
    const filename = yield* documentPath(threadId);
    const temporary = `${filename}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* fs.writeFileString(temporary, encodeStored(value), { mode: 0o600, flag: "wx" });
    yield* fs
      .rename(temporary, filename)
      .pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
  });
  yield* storage(fs.makeDirectory(input.directory, { recursive: true, mode: 0o700 }));
  const scriptPath = path.join(input.directory, "capture.cjs");
  let helperReady = false;
  let disposed = false;
  const updateAttention = (
    binding: Binding,
    attention: NativeAgentAttention | null,
    occurredAt: number,
  ) =>
    Effect.gen(function* () {
      if (
        binding.provider !== "claude" ||
        occurredAt < (binding.lastAttentionAt ?? -Infinity) ||
        (occurredAt === binding.lastAttentionAt &&
          binding.attention === undefined &&
          attention !== null)
      )
        return;
      binding.lastAttentionAt = occurredAt;
      binding.attention = attention ?? undefined;
      yield* input.onAttention?.(binding, attention) ?? Effect.void;
    });
  const accept = Effect.fn("NativeReplyCapture.accept")(function* (token: string, body: string) {
    const binding = bindings.get(token);
    if (
      !binding ||
      disposed ||
      (binding.expiresAt !== null && binding.expiresAt < (yield* Clock.currentTimeMillis))
    )
      return 403;
    const parsed = yield* decodeDelivery(body).pipe(Effect.result);
    if (parsed._tag === "Failure") return 400;
    const delivery = parsed.success;
    if ("attention" in delivery) {
      if (binding.provider !== "claude") return 400;
      if ((delivery.hook_event_name === "Notification") === (delivery.attention === "clear"))
        return 400;
      return yield* locks.withLock(
        binding.threadId,
        Effect.gen(function* () {
          if (disposed || !bindings.has(token)) return 403;
          // Retired hooks may still finish recording a reply, but cannot change
          // attention owned by a replacement process for the same terminal.
          if (binding.expiresAt !== null) return 200;
          if (
            delivery.hook_event_name === "Stop" &&
            binding.attention &&
            binding.attention.sessionId !== delivery.session_id
          )
            return 200;
          yield* updateAttention(
            binding,
            delivery.attention === "clear"
              ? null
              : {
                  threadId: binding.threadId,
                  terminalId: binding.terminalId,
                  provider: "claude",
                  sessionId: delivery.session_id,
                  kind: delivery.attention,
                  requestedAt: DateTime.formatIso(yield* DateTime.now),
                },
            delivery.occurred_at,
          );
          return 200;
        }),
      );
    }
    if (!delivery.last_assistant_message.trim()) return 400;
    const boundedReply = truncateNativeReplyText(delivery.last_assistant_message);
    if (binding.provider === "codex" && delivery.turn_id === null) return 400;
    return yield* locks
      .withLock(
        binding.threadId,
        Effect.gen(function* () {
          if (disposed || !bindings.has(token)) return 403;
          // Reply capture runs asynchronously; it may arrive after the next
          // prompt. Only synchronous lifecycle hooks change native attention.
          // Native /clear and /resume can change session_id without restarting the
          // PTY. Only the launch token chooses the Stark thread, never these fields.
          const state = yield* load(binding.threadId);
          const deliveryKey = yield* digest(`${token}:${delivery.deliveryId}`);
          const replyId = yield* digest(
            encodeIdentity([
              binding.provider,
              binding.terminalId,
              delivery.session_id,
              delivery.turn_id ?? delivery.deliveryId,
              delivery.last_assistant_message,
            ]),
          );
          if (
            state.deliveries.includes(deliveryKey) ||
            state.deliveries.includes(replyId) ||
            state.replies.some((reply) => reply.id === replyId)
          )
            return 200;
          const reply: NativeAgentReply = {
            id: replyId,
            threadId: binding.threadId,
            terminalId: binding.terminalId,
            provider: binding.provider,
            sessionId: delivery.session_id,
            turnId: delivery.turn_id,
            text: boundedReply.text,
            ...(delivery.truncated || boundedReply.truncated ? { truncated: true } : {}),
            ...(delivery.evidence === undefined ? {} : { evidence: delivery.evidence }),
            capturedAt: DateTime.formatIso(yield* DateTime.now),
            sequence: state.sequence + 1,
          };
          const replies = [...state.replies, reply].slice(-MAX_REPLIES);
          const next = {
            version: 1 as const,
            sequence: reply.sequence,
            replies,
            deliveries: [...state.deliveries, deliveryKey, replyId].slice(-400),
          };
          while (Buffer.byteLength(encodeStored(next)) > MAX_HISTORY_BYTES && replies.length > 1)
            replies.shift();
          yield* save(binding.threadId, next);
          yield* input.onReply(reply, replies);
          return 200;
        }),
      )
      .pipe(Effect.catch(() => Effect.succeed(500)));
  });
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const pending = new Set<Promise<void>>();
  const server = NodeHttp.createServer((request, response) => {
    // A CLI hook can exit while posting. Node emits socket errors on both
    // streams; they must never escape into the app server's process.
    request.on("error", () => response.destroy());
    response.on("error", () => response.destroy());
    response.setHeader("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      request.method !== "POST" ||
      request.url !== "/native-replies" ||
      request.headers.host !== `127.0.0.1:${address.port}` ||
      request.headers.origin !== undefined ||
      request.headers["content-type"] !== "application/json" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !bindings.has(token)
    ) {
      response.writeHead(403).end();
      request.resume();
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > MAX_BODY_BYTES) return;
      const complete = (status: number) => {
        if (!response.destroyed && !response.writableEnded) response.writeHead(status).end();
      };
      const task = runPromise(accept(token, Buffer.concat(chunks).toString("utf8")))
        .then(complete, () => complete(500))
        .finally(() => pending.delete(task));
      pending.add(task);
    });
  });
  server.maxHeadersCount = 16;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      disposed = true;
      bindings.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(pending);
    }),
  );
  const port = yield* storage(
    Effect.tryPromise(
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            const address = server.address();
            if (!address || typeof address === "string")
              return reject(new Error("No loopback address."));
            resolve(address.port);
          });
        }),
    ),
  );
  const bind = Effect.fn("NativeReplyCapture.bind")(function* (
    binding: Pick<Binding, "threadId" | "terminalId" | "provider">,
  ) {
    yield* locks.withLock(
      "capture-helper",
      Effect.gen(function* () {
        if (!helperReady) {
          yield* storage(fs.writeFileString(scriptPath, nativeReplyHookSource, { mode: 0o600 }));
          helperReady = true;
        }
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const [token, value] of bindings)
      if (value.expiresAt !== null && value.expiresAt < now) bindings.delete(token);
    if (disposed || bindings.size >= 512)
      return yield* new NativeReplyCaptureError({ cause: "Capture session limit reached." });
    const token = Buffer.from(yield* storage(crypto.randomBytes(32))).toString("hex");
    bindings.set(token, { ...binding, expiresAt: null });
    return {
      command: nativeReplyHookCommand({ ...input, scriptPath, provider: binding.provider }),
      env: {
        STARK_NATIVE_REPLY_ENDPOINT: `http://127.0.0.1:${port}/native-replies`,
        STARK_NATIVE_REPLY_TOKEN: token,
        STARK_NATIVE_REPLY_PROVIDER: binding.provider,
      },
    };
  });
  const list = (filter: TerminalNativeRepliesInput) =>
    storage(
      locks.withLock(
        filter.threadId,
        load(filter.threadId).pipe(
          Effect.map((value) =>
            value.replies.filter(
              (reply) => filter.terminalId === undefined || reply.terminalId === filter.terminalId,
            ),
          ),
        ),
      ),
    );
  const retire = (filter: TerminalNativeRepliesInput) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const binding of bindings.values())
        if (matches(binding, filter) && binding.expiresAt === null) {
          binding.expiresAt = now + 60_000;
          yield* updateAttention(binding, null, Math.max(now, binding.lastAttentionAt ?? now));
        }
    });
  const remove = (filter: TerminalNativeRepliesInput) =>
    storage(
      locks.withLock(
        filter.threadId,
        Effect.gen(function* () {
          for (const [token, binding] of bindings)
            if (matches(binding, filter)) {
              bindings.delete(token);
              const now = yield* Clock.currentTimeMillis;
              yield* updateAttention(binding, null, Math.max(now, binding.lastAttentionAt ?? now));
            }
          if (filter.terminalId === undefined)
            yield* fs.remove(yield* documentPath(filter.threadId), { force: true });
          else {
            const state = yield* load(filter.threadId);
            yield* save(filter.threadId, {
              ...state,
              replies: state.replies.filter((reply) => reply.terminalId !== filter.terminalId),
            });
          }
        }),
      ),
    );
  return NativeReplyCapture.of({ bind, list, retire, remove });
});
