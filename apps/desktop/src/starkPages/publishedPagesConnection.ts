// The official MCP SDK owns OAuth/PKCE and MCP framing. This adapter owns its app-local session.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- bounded in-memory cache inside the Promise-based MCP SDK adapter
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  StarkPublishedPagesBridge,
  StarkPublishedPageDocument,
  StarkPublishedPagesStatus,
  StarkPublishedPagesReadInput,
  StarkPublishedPagesReadResult,
  StarkPublishedPagesTool,
} from "@starkfuture/contracts";
import {
  boundedJson,
  isReadTool,
  PAGES_MCP_URL,
  PAGES_ORIGIN,
  PAGES_SCOPE,
  pinnedPagesFetch,
  PublishedPagesFailure,
  sanitizeReadResult,
  sanitizeReadTool,
} from "./publishedPagesPolicy.ts";
import {
  downloadPageAsset,
  loadPublishedPage,
  validatePublishedPage,
} from "./publishedPagesAssets.ts";
import { pagesOAuthCallback } from "./publishedPagesCallback.ts";
import type { PublishedPagesCredentials, PublishedPagesStore } from "./publishedPagesStore.ts";

const disconnected: StarkPublishedPagesStatus = { state: "signed-out", message: null };
export interface PublishedPagesConnection extends StarkPublishedPagesBridge {
  dispose(): Promise<void>;
  /** Lifecycle/test synchronization; never exposed over IPC. */
  settled(): Promise<void>;
}

export function createPublishedPagesConnection(input: {
  store: PublishedPagesStore;
  openExternal(url: string): Promise<boolean>;
  fetch?: FetchLike;
  assetFetch?: typeof fetch;
}): PublishedPagesConnection {
  let status: StarkPublishedPagesStatus = disconnected;
  let credentials: PublishedPagesCredentials | undefined;
  let loaded = false;
  let restoreFailed = false;
  let loading: Promise<void> | undefined;
  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  let requestQueue: Promise<void> = Promise.resolve();
  const controllers = new Set<AbortController>();
  const pageCache = new Map<
    string,
    { document: StarkPublishedPageDocument; at: number; bytes: number }
  >();
  const failure = (error: unknown) =>
    error instanceof PublishedPagesFailure ? error : new PublishedPagesFailure("network");
  const current = (expected: number) => {
    if (expected !== generation) throw new PublishedPagesFailure("cancelled");
  };
  const load = async () => {
    if (loaded) return;
    if (!loading)
      loading = (async () => {
        try {
          credentials = await input.store.load();
          restoreFailed = false;
          status = disconnected;
          if (credentials?.tokens) status = { state: "connected", message: null };
        } catch {
          restoreFailed = true;
          status = { state: "error", message: new PublishedPagesFailure("storage").message };
        } finally {
          loaded = true;
          loading = undefined;
        }
      })();
    await loading;
  };

  const provider = (
    expected: number,
    options?: { redirectUrl: string; state: string; beforeSave(): void },
  ): OAuthClientProvider => {
    let verifier: string | undefined;
    let saveFailure: PublishedPagesFailure | undefined;
    let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>>;
    const persist = async () => {
      current(expected);
      if (!credentials) throw new PublishedPagesFailure("auth");
      options?.beforeSave();
      await input.store.save(credentials);
      current(expected);
    };
    return {
      get redirectUrl() {
        return options?.redirectUrl ?? credentials?.redirectUrl;
      },
      get clientMetadata() {
        const redirect = options?.redirectUrl ?? credentials?.redirectUrl;
        if (!redirect) throw new PublishedPagesFailure("auth");
        return {
          client_name: "Stark Code",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
          scope: PAGES_SCOPE,
        };
      },
      state: () => {
        current(expected);
        if (!options) {
          if (saveFailure) throw saveFailure;
          // SDK refresh falls back to authorization after a temporary network/server failure.
          // A retained refresh token means it was not rejected; preserve the saved sign-in so
          // the next read can retry instead of stranding the app in a sign-in-required state.
          throw new PublishedPagesFailure(credentials?.tokens?.refresh_token ? "network" : "auth");
        }
        return options.state;
      },
      clientInformation: () => {
        current(expected);
        return credentials?.registration;
      },
      saveClientInformation: async (client) => {
        current(expected);
        if (!options) throw new PublishedPagesFailure("auth");
        credentials = { version: 1, redirectUrl: options.redirectUrl, registration: client };
        await persist();
      },
      tokens: () => {
        current(expected);
        return credentials?.tokens;
      },
      saveTokens: async (tokens) => {
        current(expected);
        if (!credentials) throw new PublishedPagesFailure("auth");
        credentials = { ...credentials, tokens };
        try {
          await persist();
        } catch {
          current(expected);
          credentials = undefined;
          restoreFailed = true;
          saveFailure = new PublishedPagesFailure("storage");
          throw saveFailure;
        }
      },
      redirectToAuthorization: async (url) => {
        current(expected);
        if (!options) throw new PublishedPagesFailure("auth");
        if (
          url.origin !== PAGES_ORIGIN ||
          url.pathname !== "/authorize" ||
          url.username ||
          url.password ||
          url.hash ||
          url.searchParams.get("state") !== options.state ||
          url.searchParams.get("redirect_uri") !== options.redirectUrl ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !url.searchParams.get("code_challenge") ||
          url.searchParams.get("scope") !== PAGES_SCOPE
        )
          throw new PublishedPagesFailure("invalid");
        if (!(await input.openExternal(url.href))) throw new PublishedPagesFailure("network");
        current(expected);
        status = { state: "connecting", message: "Complete Stark Pages sign-in in your browser." };
      },
      saveCodeVerifier: (value) => {
        current(expected);
        verifier = value;
      },
      codeVerifier: () => {
        if (!verifier) throw new PublishedPagesFailure("auth");
        return verifier;
      },
      validateResourceURL: async (_url, resource) => {
        const expectedResource = `${PAGES_ORIGIN}/mcp`;
        if (resource && resource.replace(/\/$/, "") !== expectedResource)
          throw new PublishedPagesFailure("invalid");
        return new URL(expectedResource);
      },
      saveDiscoveryState: (value) => {
        current(expected);
        discovery = value;
      },
      discoveryState: () => discovery,
      invalidateCredentials: async (scope) => {
        current(expected);
        if (scope === "discovery" || scope === "all") discovery = undefined;
        if (scope === "verifier" || scope === "all") verifier = undefined;
        if (scope === "all" || scope === "client") {
          credentials = undefined;
          await input.store.clear();
        } else if (scope === "tokens" && credentials) {
          const { tokens: _tokens, ...remaining } = credentials;
          credentials = remaining;
          await persist();
        }
      },
    };
  };

  const withClient = async <T>(
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    expected: number,
  ): Promise<T> => {
    current(expected);
    if (!credentials?.tokens) throw new PublishedPagesFailure("auth");
    const controller = new AbortController();
    controllers.add(controller);
    const client = new Client({ name: "stark-code-pages", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(PAGES_MCP_URL), {
      authProvider: provider(expected),
      fetch: pinnedPagesFetch(input.fetch, controller.signal),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    // SDK errors may include OAuth response bodies. Never log them or forward them to the renderer.
    client.onerror = () => undefined;
    try {
      // Adapt SDK1.29's exact-optional mismatch without weakening our compiler settings.
      // The HTTP transport retains the MCP session ID internally for every request.
      const wire: Transport = {
        start: async () => {
          transport.onclose = () => wire.onclose?.();
          transport.onerror = (error) => wire.onerror?.(error);
          transport.onmessage = (message) => wire.onmessage?.(message);
          await transport.start();
        },
        send: (message, options) => transport.send(message, options),
        close: () => transport.close(),
        setProtocolVersion: (version) => transport.setProtocolVersion(version),
      };
      await client.connect(wire, { timeout: 30_000 });
      const result = await operation(client, controller.signal);
      current(expected);
      return result;
    } finally {
      if (transport.sessionId && !controller.signal.aborted && expected === generation)
        await transport.terminateSession().catch(() => undefined);
      controller.abort();
      controllers.delete(controller);
      await client.close().catch(() => undefined);
    }
  };
  const tools = async (client: Client): Promise<StarkPublishedPagesTool[]> => {
    const found: StarkPublishedPagesTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      for (const tool of result.tools) {
        const allowed = sanitizeReadTool(tool);
        if (allowed && !found.some((entry) => entry.name === allowed.name)) found.push(allowed);
      }
      if (!result.nextCursor) return found;
      if (seen.has(result.nextCursor)) throw new PublishedPagesFailure("invalid");
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new PublishedPagesFailure("limit");
  };
  const readTool = async (
    client: Client,
    value: StarkPublishedPagesReadInput,
    available?: readonly StarkPublishedPagesTool[],
  ): Promise<StarkPublishedPagesReadResult> => {
    const args = boundedJson(value.arguments, 32 * 1024);
    const schema = (available ?? (await tools(client))).find(
      (entry) => entry.name === value.tool,
    )?.inputSchema;
    if (!schema) throw new PublishedPagesFailure("invalid");
    try {
      if (!new AjvJsonSchemaValidator().getValidator(schema)(args).valid)
        throw new PublishedPagesFailure("invalid");
    } catch {
      throw new PublishedPagesFailure("invalid");
    }
    return sanitizeReadResult(
      await client.callTool({ name: value.tool, arguments: value.arguments }, undefined, {
        timeout: 30_000,
      }),
    );
  };
  const request = <T>(
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    // Capture before queueing: sign-out cancels queued reads as well as active requests.
    const expected = generation;
    const result = requestQueue.then(async () => {
      current(expected);
      await load();
      current(expected);
      if (status.state !== "connected") throw new PublishedPagesFailure("auth");
      try {
        return await withClient(operation, expected);
      } catch (error) {
        const safe = failure(error);
        if (expected === generation) {
          if (safe.reason === "auth")
            status = {
              state: "signed-out",
              message: "Your Pages sign-in has expired. Continue in your browser to reconnect.",
            };
          else if (safe.reason === "storage") status = { state: "error", message: safe.message };
        }
        throw safe;
      }
    });
    requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const cancel = () => {
    generation++;
    pageCache.clear();
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };

  return {
    status: async () => {
      await load();
      return status;
    },
    connect: async () => {
      // Status polling never repeats a denied Keychain request. An explicit retry must first
      // restore the existing sign-in, rather than erase it and start browser authorization.
      if (restoreFailed && !loading) loaded = false;
      await load();
      if (restoreFailed) return status;
      if (status.state === "connecting" || status.state === "connected") return status;
      cancel();
      const expected = generation;
      const controller = new AbortController();
      controllers.add(controller);
      status = { state: "connecting", message: "Opening Stark Pages sign-in…" };
      pending = (async () => {
        let callback: Awaited<ReturnType<typeof pagesOAuthCallback>> | undefined;
        let cleanupNeeded = false;
        try {
          await input.store.ready();
          current(expected);
          credentials = undefined;
          await input.store.clear();
          current(expected);
          const state = NodeCrypto.randomBytes(32).toString("hex");
          callback = await pagesOAuthCallback(state, controller.signal);
          current(expected);
          const oauth = provider(expected, {
            redirectUrl: callback.url,
            state,
            // A failed write may have persisted data, so clean up even when save rejects.
            beforeSave: () => {
              cleanupNeeded = true;
            },
          });
          const options = {
            serverUrl: PAGES_MCP_URL,
            scope: PAGES_SCOPE,
            resourceMetadataUrl: new URL(`${PAGES_ORIGIN}/.well-known/oauth-protected-resource`),
            fetchFn: pinnedPagesFetch(input.fetch, controller.signal),
          };
          const outcome = await auth(oauth, options);
          if (outcome === "REDIRECT") {
            const authorizationCode = await callback.code;
            current(expected);
            status = { state: "connecting", message: "Finishing Stark Pages sign-in…" };
            if ((await auth(oauth, { ...options, authorizationCode })) !== "AUTHORIZED")
              throw new PublishedPagesFailure("auth");
          }
          await withClient(tools, expected);
          current(expected);
          status = { state: "connected", message: null };
        } catch (error) {
          if (expected === generation) {
            const safe = failure(error);
            if (credentials?.tokens && safe.reason === "network") {
              // Authorization is already saved. A failed first read must not discard it.
              status = { state: "connected", message: null };
            } else {
              credentials = undefined;
              status = {
                state: safe.reason === "auth" ? "signed-out" : "error",
                message: safe.message,
              };
              if (cleanupNeeded)
                await input.store.clear().catch(() => {
                  status = {
                    state: "error",
                    message: new PublishedPagesFailure("storage").message,
                  };
                });
            }
          }
        } finally {
          callback?.close();
          controller.abort();
          controllers.delete(controller);
        }
      })();
      return status;
    },
    disconnect: async () => {
      await load();
      cancel();
      credentials = undefined;
      try {
        await input.store.clear();
        status = disconnected;
      } catch {
        status = { state: "error", message: new PublishedPagesFailure("storage").message };
      }
      return status;
    },
    listTools: () => request(tools),
    read: (value: StarkPublishedPagesReadInput): Promise<StarkPublishedPagesReadResult> => {
      if (!isReadTool(value.tool)) return Promise.reject(new PublishedPagesFailure("invalid"));
      return request((client) => readTool(client, value));
    },
    openPage: (value) => {
      let path: string;
      try {
        path = validatePublishedPage(value.root, value.path);
      } catch (error) {
        return Promise.reject(error);
      }
      return request(async (client, signal) => {
        const key = JSON.stringify([value.root, path]);
        const cached = pageCache.get(key);
        if (!value.refresh && cached && Date.now() - cached.at < 5 * 60_000)
          return structuredClone(cached.document);
        pageCache.delete(key);
        const available = await tools(client);
        const expected = generation;
        const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        const document = await loadPublishedPage({
          root: value.root,
          path,
          read: async (tool, args) => {
            current(expected);
            if (pageSignal.aborted) throw new PublishedPagesFailure("cancelled");
            return readTool(client, { tool, arguments: args }, available);
          },
          download: (url) => downloadPageAsset(url, input.assetFetch, pageSignal),
        });
        current(expected);
        if (pageSignal.aborted) throw new PublishedPagesFailure("cancelled");
        const bytes = Buffer.byteLength(JSON.stringify(document));
        pageCache.set(key, { document, at: Date.now(), bytes });
        while (
          pageCache.size > 8 ||
          [...pageCache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 32 * 1024 * 1024
        ) {
          const oldest = pageCache.keys().next().value;
          if (oldest === undefined) break;
          pageCache.delete(oldest);
        }
        return structuredClone(document);
      });
    },
    dispose: async () => {
      cancel();
      await Promise.all([pending, requestQueue]);
    },
    settled: () => pending,
  };
}
