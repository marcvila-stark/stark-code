import { AgentSessionScanError, ThreadId, type TerminalSummary } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const Owner = Schema.Struct({
  threadId: ThreadId,
  driver: Schema.String,
  nativeId: Schema.String,
});
const decodeOwners = Schema.decodeUnknownEffect(Schema.Array(Owner));
const decodeReplies = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      replies: Schema.Array(
        Schema.Struct({
          threadId: ThreadId,
          provider: Schema.Literals(["claude", "codex"]),
          sessionId: Schema.String,
        }),
      ),
    }),
  ),
);
export type LocalSessionOwner = typeof Owner.Type;

/** Includes archived/deleted owners: rediscovery must never resurrect or steal their bindings. */
export class LocalAgentHistoryStore extends Context.Service<
  LocalAgentHistoryStore,
  {
    readonly owners: Effect.Effect<ReadonlyArray<LocalSessionOwner>, AgentSessionScanError>;
    /** Native terminals do not expose a resumable session ID before their first reply. */
    readonly activeNativeDirectories: Effect.Effect<ReadonlyArray<string>>;
  }
>()("stark-code/project/LocalAgentHistoryStore") {}

export const layer = Layer.effect(
  LocalAgentHistoryStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const terminalManager = yield* TerminalManager.TerminalManager;
    const activeNativeDirectories = new Map<string, string>();
    const updateTerminal = (terminal: TerminalSummary) => {
      const key = `${terminal.threadId}\0${terminal.terminalId}`;
      if (
        terminal.agentShell === true &&
        (terminal.status === "starting" || terminal.status === "running")
      ) {
        activeNativeDirectories.set(key, terminal.worktreePath ?? terminal.cwd);
      } else activeNativeDirectories.delete(key);
    };
    yield* Effect.acquireRelease(
      terminalManager.subscribeMetadata((event) =>
        Effect.sync(() => {
          switch (event.type) {
            case "snapshot":
              activeNativeDirectories.clear();
              for (const terminal of event.terminals) updateTerminal(terminal);
              break;
            case "upsert":
              updateTerminal(event.terminal);
              break;
            case "remove":
              activeNativeDirectories.delete(`${event.threadId}\0${event.terminalId}`);
              break;
          }
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    const directory = path.join(config.terminalLogsDir, "native-replies");
    const cached = new Map<
      string,
      { identity: string; owners: ReadonlyArray<LocalSessionOwner> }
    >();
    return LocalAgentHistoryStore.of({
      activeNativeDirectories: Effect.sync(() => [...new Set(activeNativeDirectories.values())]),
      owners: Effect.gen(function* () {
        const rows = yield* sql`
        SELECT thread_id AS "threadId", driver,
          json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId"
        FROM orchestration_v2_projection_provider_threads
        WHERE thread_id IS NOT NULL
          AND json_type(payload_json, '$.nativeThreadRef.nativeId') = 'text'
          AND driver IN ('codex', 'claudeAgent')
      `;
        const owners = [...(yield* decodeOwners(rows))];
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
        const retained = new Set(names);
        for (const key of cached.keys()) if (!retained.has(key)) cached.delete(key);
        for (const name of names) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          const next = yield* Effect.gen(function* () {
            const file = path.join(directory, name);
            const stat = yield* fs.stat(file);
            if (stat.type !== "File" || stat.size > 2_097_152n) return [];
            const identity = `${stat.dev}:${Option.getOrNull(stat.ino)}:${stat.size}:${Option.map(stat.mtime, (value) => value.getTime()).pipe(Option.getOrNull)}:${Option.map(stat.birthtime, (value) => value.getTime()).pipe(Option.getOrNull)}`;
            const previous = cached.get(name);
            if (previous?.identity === identity) return previous.owners;
            const stored = yield* decodeReplies(yield* fs.readFileString(file));
            const threadIds = new Set(stored.replies.map((reply) => reply.threadId));
            if (threadIds.size > 1) return [];
            const thread = stored.replies[0]?.threadId;
            if (thread !== undefined) {
              const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(thread));
              if (`${Buffer.from(hash).toString("hex")}.json` !== name) return [];
            }
            const value = stored.replies.map((reply) => ({
              threadId: reply.threadId,
              driver: reply.provider === "claude" ? "claudeAgent" : "codex",
              nativeId: reply.sessionId,
            }));
            cached.set(name, { identity, owners: value });
            return value;
          }).pipe(Effect.orElseSucceed(() => []));
          owners.push(...next);
        }
        return owners;
      }).pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      ),
    });
  }),
);
