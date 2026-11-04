// @effect-diagnostics nodeBuiltinImport:off
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type {
  StarkPublishedPageDocument,
  StarkPublishedPagesAsset,
  StarkPublishedPagesReadResult,
  StarkPublishedPagesToolName,
} from "@starkfuture/contracts";
import { PublishedPagesFailure } from "./publishedPagesPolicy.ts";

export const PAGES_DOCUMENT_BYTES = 1024 * 1024;
export const PAGES_ASSET_BYTES = 2 * 1024 * 1024;
const PAGES_BUNDLE_BYTES = 10 * 1024 * 1024;
const PAGES_ASSET_COUNT = 64;
const PAGES_DOWNLOAD_HOST = "vibecoded-apps.s3.eu-west-1.amazonaws.com";

type ReadPageTool = (
  tool: StarkPublishedPagesToolName,
  args: Record<string, string>,
) => Promise<StarkPublishedPagesReadResult>;

/** Canonical project-relative paths; encoded traversal is checked before normalization. */
export function pageAssetPath(reference: string, from = "index.html"): string | null {
  if (!reference || reference.length > 2048 || /[\p{Cc}\p{Cf}\\]/u.test(reference)) return null;
  const raw = reference.trim().split(/[?#]/, 1)[0]!;
  if (!raw || raw.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[\p{Cc}\p{Cf}\\%:?#]/u.test(decoded) || decoded.startsWith("//")) return null;
  const parts = raw.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** Published links sometimes use a full Pages URL rather than a project-relative path. */
export function pageResourcePath(reference: string, from: string, root: string): string | null {
  let relative = reference;
  const prefix = `/${encodeURIComponent(root)}/`;
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//")) {
    try {
      const url = new URL(reference, "https://pages.starkfuture.com");
      if (
        url.origin !== "https://pages.starkfuture.com" ||
        url.username ||
        url.password ||
        !url.pathname.startsWith(prefix)
      )
        return null;
      relative = `/${url.pathname.slice(prefix.length)}`;
    } catch {
      return null;
    }
  } else if (relative.startsWith(prefix)) relative = `/${relative.slice(prefix.length)}`;
  return pageAssetPath(relative, from);
}

export function validatePublishedPage(root: string, path: string): string {
  if (!root || root.length > 200 || root !== root.trim() || /[\p{Cc}\p{Cf}/\\]/u.test(root))
    throw new PublishedPagesFailure("invalid");
  const canonical = pageAssetPath(path);
  if (!canonical) throw new PublishedPagesFailure("invalid");
  return canonical;
}

export function isPagesDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      raw.length <= 8192 &&
      url.protocol === "https:" &&
      url.hostname === PAGES_DOWNLOAD_HOST &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^\/apps\/pages-[a-z\d]+\/objects\/[a-z\d/-]+$/i.test(url.pathname) &&
      url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
      Boolean(url.searchParams.get("X-Amz-Signature"))
    );
  } catch {
    return false;
  }
}

/** A signed object URL is a capability returned by the authenticated MCP read. Never add app auth. */
export async function downloadPageAsset(
  raw: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!isPagesDownloadUrl(raw)) throw new PublishedPagesFailure("invalid");
  const response = await fetcher(raw, {
    method: "GET",
    credentials: "omit",
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok || response.status >= 300 || !response.body) {
    await response.body?.cancel();
    throw new PublishedPagesFailure("network");
  }
  if (Number(response.headers.get("content-length")) > PAGES_ASSET_BYTES) {
    await response.body.cancel();
    throw new PublishedPagesFailure("limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PAGES_ASSET_BYTES) throw new PublishedPagesFailure("limit");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function resultObject(result: StarkPublishedPagesReadResult): Record<string, unknown> {
  if (result.isError) throw new PublishedPagesFailure("invalid");
  const structured = object(result.structuredContent);
  if (structured) return structured;
  for (const item of result.content) {
    try {
      const parsed = object(JSON.parse(item.text));
      if (parsed) return parsed;
    } catch {
      /* Older servers return JSON in a text content block. */
    }
  }
  throw new PublishedPagesFailure("invalid");
}

const mime = (value: unknown) =>
  typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : "";
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const fontTypes = new Set([
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/vnd.ms-fontobject",
]);
function assetMime(path: string, declared: unknown): string | null {
  const type = mime(declared);
  if (type === "text/css" || imageTypes.has(type) || fontTypes.has(type)) return type;
  if (type && type !== "application/octet-stream") return null;
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        css: "text/css",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        avif: "image/avif",
        svg: "image/svg+xml",
        ico: "image/x-icon",
        woff: "font/woff",
        woff2: "font/woff2",
        ttf: "font/ttf",
        otf: "font/otf",
      } as Record<string, string>
    )[extension ?? ""] ?? null
  );
}

/** Only passive resources are collected. Scripts, frames, media and forms never become fetches. */
function htmlReferences(source: string): string[] {
  const references: string[] = [];
  const nodes: DefaultTreeAdapterMap["node"][] = [parse(source)];
  while (nodes.length) {
    const node = nodes.pop()!;
    if ("childNodes" in node) nodes.push(...node.childNodes);
    if (!("tagName" in node)) continue;
    const attr = (name: string) => node.attrs.find((entry) => entry.name === name)?.value;
    const style = attr("style");
    if (style) references.push(...cssReferences(style));
    if (node.tagName === "style")
      references.push(
        ...cssReferences(
          node.childNodes
            .filter((child) => "value" in child)
            .map((child) => ("value" in child ? child.value : ""))
            .join(""),
        ),
      );
    if (node.tagName === "link" && attr("rel")?.toLowerCase().split(/\s+/).includes("stylesheet")) {
      const href = attr("href");
      if (href) references.push(href);
    }
    if (["img", "source"].includes(node.tagName)) {
      const src = attr("src");
      if (src) references.push(src);
      const srcset = attr("srcset");
      if (srcset && !srcset.trim().startsWith("data:"))
        references.push(
          ...srcset
            .split(",")
            .map((candidate) => candidate.trim().split(/\s+/, 1)[0]!)
            .filter(Boolean),
        );
    }
    if (node.tagName === "video") {
      const poster = attr("poster");
      if (poster) references.push(poster);
    }
  }
  return references;
}

function cssReferences(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const references: string[] = [];
  for (const match of css.matchAll(
    /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)]*))\s*\)|@import\s+["']([^"']+)["']/gi,
  )) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (raw)
      references.push(
        raw.replace(
          /\\([\da-f]{1,6})(?:\s)?|\\([^\r\n])/gi,
          (_, hex: string | undefined, character: string | undefined) =>
            hex
              ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
              : (character ?? ""),
        ),
      );
  }
  return references;
}

export async function loadPublishedPage(input: {
  root: string;
  path: string;
  read: ReadPageTool;
  download(url: string): Promise<Uint8Array>;
}): Promise<StarkPublishedPageDocument> {
  const path = validatePublishedPage(input.root, input.path);
  const page = resultObject(
    await input.read("pages_read_file", { root: input.root, path, mode: "text" }),
  );
  if (page.kind !== "text" || typeof page.text !== "string")
    throw new PublishedPagesFailure("invalid");
  if (page.truncated === true || Buffer.byteLength(page.text) > PAGES_DOCUMENT_BYTES)
    throw new PublishedPagesFailure("limit");
  const mimeType = mime(page.content_type) || (/\.html?$/i.test(path) ? "text/html" : "text/plain");
  const assets: StarkPublishedPagesAsset[] = [];
  const warnings = new Set<string>();
  const queue: { reference: string; from: string; depth: number }[] =
    mimeType === "text/html"
      ? htmlReferences(page.text).map((reference) => ({ reference, from: path, depth: 0 }))
      : [];
  const seen = new Set([path]);
  let total = Buffer.byteLength(page.text);
  let examined = 0;
  let attempted = 0;
  for (let next = 0; next < queue.length; next++) {
    const entry = queue[next]!;
    if (++examined > 512) {
      warnings.add(
        "Some page resources were omitted because this page contains too many references.",
      );
      break;
    }
    if (/^(?:data:|#)/i.test(entry.reference)) continue;
    const assetPath = pageResourcePath(entry.reference, entry.from, input.root);
    if (!assetPath) {
      warnings.add(
        "External or unsupported page resources were omitted. Open in your browser for the complete page.",
      );
      continue;
    }
    if (seen.has(assetPath)) continue;
    seen.add(assetPath);
    if (attempted >= PAGES_ASSET_COUNT || total >= PAGES_BUNDLE_BYTES || entry.depth > 8) {
      warnings.add("Some page resources were omitted because this page exceeds the preview limit.");
      continue;
    }
    attempted++;
    try {
      const result = resultObject(
        await input.read("pages_read_file", {
          root: input.root,
          path: assetPath,
          mode: /\.css$/i.test(assetPath) ? "text" : "download",
        }),
      );
      const mimeType = assetMime(assetPath, result.content_type);
      if (
        !mimeType ||
        result.truncated === true ||
        (typeof result.size_bytes === "number" && result.size_bytes > PAGES_ASSET_BYTES)
      )
        throw new PublishedPagesFailure("limit");
      let content: string;
      let encoding: "utf8" | "base64";
      let bytes: number;
      if (result.kind === "text" && typeof result.text === "string") {
        content = result.text;
        bytes = Buffer.byteLength(content);
        encoding = "utf8";
      } else if (result.kind === "download" && typeof result.url === "string") {
        const downloaded = await input.download(result.url);
        bytes = downloaded.byteLength;
        encoding = mimeType === "text/css" ? "utf8" : "base64";
        content = Buffer.from(downloaded).toString(encoding === "utf8" ? "utf8" : "base64");
      } else throw new PublishedPagesFailure("invalid");
      if (bytes > PAGES_ASSET_BYTES || total + bytes > PAGES_BUNDLE_BYTES)
        throw new PublishedPagesFailure("limit");
      total += bytes;
      assets.push({ path: assetPath, mimeType, content, encoding });
      if (mimeType === "text/css")
        queue.push(
          ...cssReferences(content).map((reference) => ({
            reference,
            from: assetPath,
            depth: entry.depth + 1,
          })),
        );
    } catch (error) {
      if (
        error instanceof PublishedPagesFailure &&
        ["auth", "cancelled", "storage"].includes(error.reason)
      )
        throw error;
      warnings.add(
        "Some page styles or images could not be loaded. Refresh to try again, or open in your browser.",
      );
    }
  }
  let publicUrl: string | null = null;
  try {
    const result = resultObject(
      await input.read("pages_get_public_url", { root: input.root, path }),
    );
    const candidate = typeof result.url === "string" ? result.url : null;
    if (candidate) {
      const url = new URL(candidate);
      if (url.origin === "https://pages.starkfuture.com" && !url.username && !url.password)
        publicUrl = url.href;
    }
  } catch (error) {
    if (
      error instanceof PublishedPagesFailure &&
      ["auth", "cancelled", "storage"].includes(error.reason)
    )
      throw error;
  }
  return {
    root: input.root,
    path,
    source: page.text,
    mimeType,
    assets,
    warnings: [...warnings],
    publicUrl,
  };
}
