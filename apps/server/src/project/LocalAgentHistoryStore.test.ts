// @effect-diagnostics nodeBuiltinImport:off -- Hash fixture names exactly like the durable native reply capture format.
import * as NodeCrypto from "node:crypto";
import {
  ThreadId,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@starkfuture/contracts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LocalAgentHistoryStore from "./LocalAgentHistoryStore.ts";

const layerTestWithTerminals = (
  subscribeMetadata: TerminalManager.TerminalManager["Service"]["subscribeMetadata"],
) =>
  LocalAgentHistoryStore.layer.pipe(
    Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ subscribeMetadata })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest("/workspace", { prefix: "local-chat-owners-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const layerTest = layerTestWithTerminals((listener) =>
  listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
);
const captureFilename = (threadId: string) =>
  `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`;

const insertOwner = (id: string, threadId: string | null, nativeId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({ nativeThreadRef: { nativeId } });
    yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, provider, driver, provider_instance_id, status, updated_at, payload_json)
    VALUES (${id}, ${threadId}, 'codex', 'codex', 'codex', 'idle', '2026-10-22T00:00:00Z', ${payload})
  `;
  });

it.effect("preserves ownership even when the app thread is no longer in the active sidebar", () =>
  Effect.gen(function* () {
    const store = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
    yield* insertOwner("provider-thread:archived", "thread:archived", "native:archived");
    yield* insertOwner("provider-thread:deleted", "thread:deleted", "native:deleted");
    assert.sameDeepMembers(
      [...(yield* store.owners)],
      [
        {
          threadId: ThreadId.make("thread:archived"),
          driver: "codex",
          nativeId: "native:archived",
        },
        { threadId: ThreadId.make("thread:deleted"), driver: "codex", nativeId: "native:deleted" },
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("unowned provider threads do not prevent discovering valid owners", () =>
  Effect.gen(function* () {
    const store = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
    yield* insertOwner("provider-thread:unowned", null, "native:unowned");
    yield* insertOwner("provider-thread:owned", "thread:owned", "native:owned");
    assert.deepEqual(yield* store.owners, [
      { threadId: ThreadId.make("thread:owned"), driver: "codex", nativeId: "native:owned" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("discovers native shell ownership and refreshes changed or removed capture files", () =>
  Effect.gen(function* () {
    const store = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.terminalLogsDir, "native-replies");
    const threadId = ThreadId.make("thread:native-shell");
    const file = path.join(directory, captureFilename(threadId));
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      file,
      JSON.stringify({ replies: [{ threadId, provider: "claude", sessionId: "native:claude" }] }),
    );
    assert.deepEqual(yield* store.owners, [
      { threadId, driver: "claudeAgent", nativeId: "native:claude" },
    ]);
    yield* fs.writeFileString(
      file,
      JSON.stringify({
        replies: [{ threadId, provider: "codex", sessionId: "native:codex-followup" }],
      }),
    );
    assert.deepEqual(yield* store.owners, [
      { threadId, driver: "codex", nativeId: "native:codex-followup" },
    ]);
    yield* fs.remove(file);
    assert.deepEqual(yield* store.owners, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ignores corrupt capture files without losing SQL-owned sessions", () =>
  Effect.gen(function* () {
    const store = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.terminalLogsDir, "native-replies");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, captureFilename("thread:corrupt")),
      '{"replies":[',
    );
    yield* insertOwner("provider-thread:valid", "thread:valid", "native:valid");
    assert.deepEqual(yield* store.owners, [
      { threadId: ThreadId.make("thread:valid"), driver: "codex", nativeId: "native:valid" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ignores native captures whose recorded owner does not match the filename", () =>
  Effect.gen(function* () {
    const store = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.terminalLogsDir, "native-replies");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, captureFilename("thread:expected-owner")),
      JSON.stringify({
        replies: [
          { threadId: "thread:wrong-owner", provider: "claude", sessionId: "native:misbound" },
        ],
      }),
    );
    assert.deepEqual(yield* store.owners, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("tracks only active native terminal directories and unsubscribes with its scope", () => {
  let receive: (event: TerminalMetadataStreamEvent) => Effect.Effect<void> = () =>
    Effect.die("not subscribed");
  let unsubscribed = false;
  const terminal = (terminalId: string, patch: Partial<TerminalSummary> = {}): TerminalSummary => ({
    threadId: "shell-owner",
    terminalId,
    cwd: "/original/repo",
    worktreePath: null,
    status: "running",
    pid: 10,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "Claude",
    agentShell: true,
    updatedAt: "2026-10-22T00:00:00Z",
    ...patch,
  });
  const layer = layerTestWithTerminals((listener) => {
    receive = listener;
    return listener({
      type: "snapshot",
      terminals: [
        terminal("native"),
        terminal("ordinary", { agentShell: false, cwd: "/ordinary" }),
        terminal("exited", { status: "exited", cwd: "/finished" }),
      ],
    }).pipe(
      Effect.as(() => {
        unsubscribed = true;
      }),
    );
  });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
      assert.deepEqual(yield* store.activeNativeDirectories, ["/original/repo"]);
      yield* receive({
        type: "upsert",
        terminal: terminal("second", { status: "starting", worktreePath: "/active/worktree" }),
      });
      assert.sameMembers(
        [...(yield* store.activeNativeDirectories)],
        ["/original/repo", "/active/worktree"],
      );
      yield* receive({ type: "remove", threadId: "shell-owner", terminalId: "native" });
      assert.deepEqual(yield* store.activeNativeDirectories, ["/active/worktree"]);
      yield* receive({ type: "upsert", terminal: terminal("second", { status: "exited" }) });
      assert.deepEqual(yield* store.activeNativeDirectories, []);
    }).pipe(Effect.provide(layer));
    assert.isTrue(unsubscribed);
  });
});
