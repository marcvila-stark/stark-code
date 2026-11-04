import {
  McpServerRequestError,
  isExpectedMcpCallback,
  mcpAuthorizationHost,
  type McpServersListInput,
  type McpServersListResult,
  type McpServersReloadInput,
  type McpServersReloadResult,
  type McpServerActionInput,
  type McpServerSetEnabledInput,
  type McpServerSubmitCallbackInput,
  type McpServerSignInStart,
  type McpServerStatusEntry,
} from "@starkfuture/contracts";
import type { ProviderAdapterV2McpServers } from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstances from "./ProviderInstanceRegistry.ts";
import { catalogText } from "./Drivers/ClaudeSessionCatalog.ts";

type Client = { readonly desktopHost: boolean };
const unavailable = () =>
  new McpServerRequestError({
    reason: "unavailable",
    message: "Start a provider session in this project before managing its MCP servers.",
  });
const safeFailure = () =>
  new McpServerRequestError({
    reason: "provider_error",
    message:
      "The provider could not complete the MCP operation. Check the server's configuration and try again.",
  });
const isLocked = (name: string) => catalogText(name, 256).toLowerCase() === "stark-code";
const targetKey = (input: McpServersListInput) =>
  input.threadId ?? `${input.providerInstanceId}:${input.projectId}`;
// Redact before flattening/truncating text: otherwise a newline or a cut quote
// can turn a secret-bearing header into seemingly ordinary error prose.
const safeError = (text: string) => {
  const plain = text
    .split(/\r\n?|\n/u)
    .map((line) => catalogText(line, line.length))
    .join("\n");
  const redacted = plain
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi, (value) => {
      try {
        const url = new URL(value);
        // Paths, query strings and fragments may all contain credentials.
        // The origin preserves the useful connection destination only.
        return `${url.protocol}//${url.host}`;
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(
      /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]*)/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:code|state|password|[a-z\d_-]*(?:key|token|secret)[a-z\d_-]*)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&,;#}\]]+)/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}\]]+/gi, "[redacted]")
    .replace(/\b(?:sk-[a-z\d_-]+|gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+)\b/gi, "[redacted]");
  return catalogText(redacted, 1000);
};

class McpServerRequests extends Context.Service<
  McpServerRequests,
  {
    readonly list: (
      input: McpServersListInput,
      client?: Client,
    ) => Effect.Effect<McpServersListResult, McpServerRequestError>;
    readonly reconnect: (
      input: McpServerActionInput,
      client: Client,
    ) => Effect.Effect<void, McpServerRequestError>;
    readonly reload: (
      input: McpServersReloadInput,
      client: Client,
    ) => Effect.Effect<McpServersReloadResult, McpServerRequestError>;
    readonly setEnabled: (
      input: McpServerSetEnabledInput,
      client: Client,
    ) => Effect.Effect<void, McpServerRequestError>;
    readonly signIn: (
      input: McpServerActionInput,
      client: Client,
    ) => Effect.Effect<McpServerSignInStart, McpServerRequestError>;
    readonly submitCallback: (
      input: McpServerSubmitCallbackInput,
      client: Client,
    ) => Effect.Effect<void, McpServerRequestError>;
    readonly signOut: (
      input: McpServerActionInput,
      client: Client,
    ) => Effect.Effect<void, McpServerRequestError>;
  }
>()("stark-code/provider/McpServerRequests") {}

/** User-click RPC domain only. This service is deliberately absent from agent MCP tools. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstances.ProviderInstanceRegistry;
  const resolve = Effect.fn("McpServerRequests.resolve")(function* (input: McpServersListInput) {
    if (input.threadId) {
      const projection = yield* threads.getThreadRecords(input.threadId, ["providerThreads"]);
      const thread =
        projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        ) ?? projection.providerThreads.at(-1);
      const runtime = thread?.providerSessionId
        ? Option.getOrNull(yield* sessions.peek(thread.providerSessionId))
        : null;
      return runtime?.mcpServers;
    }
    if (!input.providerInstanceId || !input.projectId) return undefined;
    const project = Option.getOrNull(yield* projects.get(input.projectId));
    const provider = yield* providers.getInstance(input.providerInstanceId);
    return project && provider
      ? provider.orchestrationAdapter.mcpServersForCwd?.(project.workspaceRoot)
      : undefined;
  });
  return makeForResolver((input) => resolve(input).pipe(Effect.mapError(safeFailure)));
});

/** The policy boundary is testable without launching a provider or OAuth server. */
export function makeForResolver(
  resolve: (
    input: McpServersListInput,
  ) => Effect.Effect<ProviderAdapterV2McpServers | undefined, McpServerRequestError>,
) {
  const pending = new Map<string, { start: McpServerSignInStart; expiresAt: number }>();
  const control = Effect.fn("McpServerRequests.control")(function* (
    input: McpServersListInput & { readonly name?: string },
    client: Client,
    threadOnly = false,
  ): Effect.fn.Return<ProviderAdapterV2McpServers, McpServerRequestError> {
    if (!client.desktopHost)
      return yield* new McpServerRequestError({
        reason: "desktop_required",
        message: "MCP controls are available only in the desktop app on this host.",
      });
    if (threadOnly && input.threadId === undefined)
      return yield* new McpServerRequestError({
        reason: "unavailable",
        message:
          "Open a live conversation to reload its MCP servers. Settings only inspects project connections.",
      });
    if (input.name !== undefined && isLocked(input.name))
      return yield* new McpServerRequestError({
        reason: "locked",
        message: "The app's stark-code MCP server is required and cannot be changed.",
      });
    const api = yield* resolve(input).pipe(Effect.mapError(safeFailure));
    if (!api) return yield* unavailable();
    return api;
  });
  return McpServerRequests.of({
    list: (input, client) =>
      Effect.gen(function* () {
        if (!input.threadId && client?.desktopHost !== true) return { servers: [], live: false };
        const api = yield* resolve(input).pipe(Effect.mapError(safeFailure));
        if (!api) return { servers: [], live: false };
        const servers = yield* api.list().pipe(Effect.mapError(safeFailure));
        return {
          live: input.threadId !== undefined,
          ...(api.reconnectScope === undefined ? {} : { reconnectScope: api.reconnectScope }),
          canReload:
            input.threadId !== undefined &&
            client?.desktopHost === true &&
            api.reload !== undefined,
          servers: servers
            .slice(0, 2048)
            .map((server): McpServerStatusEntry => ({
              ...server,
              name: catalogText(server.name, 256),
              locked: server.locked || isLocked(server.name),
              ...(server.error ? { error: safeError(server.error) } : {}),
              tools: server.tools.slice(0, 4096).map((tool) => ({
                ...tool,
                name: catalogText(tool.name, 256),
                ...(tool.description ? { description: catalogText(tool.description, 2000) } : {}),
              })),
            }))
            .filter((server) => server.name.length > 0),
        };
      }),
    reload: (input, client) =>
      Effect.gen(function* () {
        const api = yield* control(input, client, true);
        if (api.reload === undefined) return yield* unavailable();
        const result = yield* api
          .reload({ force: input.force === true })
          .pipe(Effect.mapError(safeFailure));
        return {
          status: result.status,
          failedServers: [
            ...new Set(
              result.failedServers
                .slice(0, 2048)
                .map((name) => safeError(name).slice(0, 256))
                .filter(Boolean),
            ),
          ],
          ...(result.pluginErrors !== undefined && Number.isFinite(result.pluginErrors)
            ? { pluginErrors: Math.max(0, Math.trunc(result.pluginErrors)) }
            : {}),
        };
      }),
    reconnect: (input, client) =>
      Effect.gen(function* () {
        const api = yield* control(input, client);
        if (api.reconnectScope !== "server")
          return yield* new McpServerRequestError({
            reason: "unavailable",
            message:
              "This provider cannot reconnect one MCP server without affecting other connections. Use Reload MCPs explicitly if needed.",
          });
        yield* api.reconnect(input.name).pipe(Effect.mapError(safeFailure));
      }),
    setEnabled: (input, client) =>
      Effect.gen(function* () {
        const api = yield* control(input, client);
        yield* api.setEnabled(input.name, input.enabled).pipe(Effect.mapError(safeFailure));
      }),
    signIn: (input, client) =>
      Effect.gen(function* () {
        const api = yield* control(input, client);
        const start = yield* api.startSignIn(input.name).pipe(Effect.mapError(safeFailure));
        if (start.url ? !mcpAuthorizationHost(start.url) : !start.browserOpened || !start.completed)
          return yield* new McpServerRequestError({
            reason: "invalid_url",
            message: "The MCP server returned an unsupported sign-in address.",
          });
        pending.set(`${targetKey(input)}:${input.name}`, {
          start,
          expiresAt: (yield* Clock.currentTimeMillis) + 5 * 60_000,
        });
        return start;
      }),
    submitCallback: (input, client) =>
      Effect.gen(function* () {
        const api = yield* control(input, client);
        const key = `${targetKey(input)}:${input.name}`;
        const flow = pending.get(key);
        if (
          !flow ||
          flow.expiresAt < (yield* Clock.currentTimeMillis) ||
          !isExpectedMcpCallback(input.url, flow.start)
        )
          return yield* new McpServerRequestError({
            reason: "invalid_callback",
            message: "This address does not match the pending local sign-in. Start sign-in again.",
          });
        yield* api.submitCallback(input.name, input.url).pipe(Effect.mapError(safeFailure));
        pending.delete(key);
      }),
    signOut: (input, client) =>
      Effect.gen(function* () {
        const api = yield* control(input, client);
        yield* api.signOut(input.name).pipe(Effect.mapError(safeFailure));
        pending.delete(`${targetKey(input)}:${input.name}`);
      }),
  });
}
