import {
  StarkPublishedPagesToolName,
  type StarkPublishedPagesTool,
  type StarkPublishedPagesReadResult,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export const PAGES_MCP_URL = "https://pages-ext.starkfuture.com/mcp/";
export const PAGES_ORIGIN = "https://pages-ext.starkfuture.com";
export const PAGES_SCOPE = "google_identity.oauth_login";
export const MAX_PAGES_BYTES = 2 * 1024 * 1024;
export const isReadTool = Schema.is(StarkPublishedPagesToolName);

export class PublishedPagesFailure extends Error {
  readonly reason:
    | "auth"
    | "registration"
    | "storage"
    | "network"
    | "invalid"
    | "limit"
    | "cancelled";
  constructor(reason: PublishedPagesFailure["reason"]) {
    super(
      {
        auth: "Connect to Stark Pages to continue.",
        registration: "Pages refused Stark Code registration. Ask the Pages owner for a client.",
        storage:
          "Stark Code could not securely save the Pages connection. Check your system keychain and try again.",
        network: "Stark Pages could not complete the request. Check your connection and try again.",
        invalid: "This Pages request is not supported by the connected server.",
        limit:
          "This Pages response is too large to show. Narrow the search or choose a smaller file.",
        cancelled: "The Pages connection was cancelled.",
      }[reason],
    );
    this.reason = reason;
  }
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, max) : "";

/** No metadata URL, endpoint, or redirect from the server may widen this network boundary. */
export function isPinnedPagesRequest(raw: string | URL, method = "GET"): boolean {
  const url = new URL(raw);
  if (url.origin !== PAGES_ORIGIN || url.username || url.password || url.hash || url.search)
    return false;
  if (["/mcp", "/mcp/"].includes(url.pathname)) return ["GET", "POST", "DELETE"].includes(method);
  if (["/token", "/register"].includes(url.pathname)) return method === "POST";
  return (
    method === "GET" &&
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource/mcp/",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/",
      "/.well-known/openid-configuration",
    ].includes(url.pathname)
  );
}

/** Responses are bounded while streaming, including SSE, before the SDK parses them. */
export function pinnedPagesFetch(
  fetcher: FetchLike = fetch,
  cancellation?: AbortSignal,
): FetchLike {
  return async (input, init) => {
    const url = input;
    const method = (init?.method ?? "GET").toUpperCase();
    if (!isPinnedPagesRequest(url, method)) throw new PublishedPagesFailure("invalid");
    const signals = [
      AbortSignal.timeout(method === "DELETE" ? 2000 : 30_000),
      ...(cancellation ? [cancellation] : []),
      ...(init?.signal ? [init.signal] : []),
    ];
    const response = await fetcher(input, {
      ...init,
      method,
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.any(signals),
    });
    if (
      method === "POST" &&
      new URL(url).pathname === "/register" &&
      [400, 401, 403].includes(response.status)
    ) {
      await response.body?.cancel();
      throw new PublishedPagesFailure("registration");
    }
    if (response.status >= 300 && response.status < 400) throw new PublishedPagesFailure("invalid");
    if (Number(response.headers.get("content-length")) > MAX_PAGES_BYTES) {
      await response.body?.cancel();
      throw new PublishedPagesFailure("limit");
    }
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > MAX_PAGES_BYTES) throw new PublishedPagesFailure("limit");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function boundedJson(value: unknown, maxBytes: number, depth = 0): Schema.Json {
  if (depth > 16) throw new PublishedPagesFailure("limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > maxBytes)
      throw new PublishedPagesFailure("limit");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new PublishedPagesFailure("limit");
    return value.map((entry) => boundedJson(entry, maxBytes, depth + 1));
  }
  if (typeof value !== "object" || value === undefined) throw new PublishedPagesFailure("invalid");
  const entries = Object.entries(value);
  if (entries.length > 10_000) throw new PublishedPagesFailure("limit");
  const output: Record<string, Schema.Json> = {};
  for (const [key, entry] of entries) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new PublishedPagesFailure("invalid");
    output[key] = boundedJson(entry, maxBytes, depth + 1);
  }
  if (depth === 0 && new TextEncoder().encode(JSON.stringify(output)).byteLength > maxBytes)
    throw new PublishedPagesFailure("limit");
  return output;
}

/** Keep standard JSON Schema shape, but no remote references or unbounded descriptions. */
function sanitizeSchema(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, Schema.Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "$ref" || key === "$dynamicRef") &&
      (typeof entry !== "string" || !entry.startsWith("#"))
    )
      throw new PublishedPagesFailure("invalid");
    // IDs and comments are not required for the form or local argument validation.
    if (["$id", "$schema", "$comment", "examples"].includes(key)) continue;
    result[key] =
      key === "title" || key === "description" ? text(entry, 2000) : sanitizeSchema(entry);
  }
  return result;
}

const TITLES = {
  pages_list_projects: "Browse projects",
  pages_search: "Search Pages",
  pages_read_content: "Read page",
  pages_read_file: "Read file",
  pages_get_public_url: "Get page link",
};
const isJsonObject = (value: Schema.Json): value is Record<string, Schema.Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function sanitizeReadTool(value: {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}): StarkPublishedPagesTool | null {
  if (!isReadTool(value.name)) return null;
  const schema = sanitizeSchema(boundedJson(value.inputSchema, 64 * 1024));
  if (!isJsonObject(schema) || schema.type !== "object") throw new PublishedPagesFailure("invalid");
  return {
    name: value.name,
    title: TITLES[value.name],
    description: text(value.description, 2000),
    inputSchema: schema,
  };
}

export function sanitizeReadResult(raw: unknown): StarkPublishedPagesReadResult {
  const data = boundedJson(raw, MAX_PAGES_BYTES);
  if (!isJsonObject(data)) throw new PublishedPagesFailure("invalid");
  const content: { type: "text"; text: string }[] = [];
  for (const item of Array.isArray(data.content) ? data.content.slice(0, 100) : []) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    )
      content.push({ type: "text", text: item.text });
  }
  return {
    content,
    ...(data.structuredContent === undefined ? {} : { structuredContent: data.structuredContent }),
    isError: data.isError === true,
  };
}
