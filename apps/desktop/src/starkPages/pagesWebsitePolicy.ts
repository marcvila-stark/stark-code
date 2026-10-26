import type { PagesWebsiteBounds } from "@starkfuture/contracts";

export const PAGES_WEBSITE_HOME = "https://pages.starkfuture.com/";
// Personal browsing is deliberately outside BrowserSession's agent/profile registry.
export const PAGES_WEBSITE_PARTITION = "persist:stark-pages-personal-v1";

export function pagesWebsiteUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (url.hostname !== "pages.starkfuture.com") return;
    return url;
  } catch {
    return;
  }
}

/** The website's own Google sign-in chain, in the same isolated personal session. */
export function pagesWebsiteNavigationUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (
      !["pages.starkfuture.com", "vibecoded-ext.starkfuture.com", "accounts.google.com"].includes(
        url.hostname,
      )
    )
      return;
    return url;
  } catch {
    return;
  }
}

export function safeWebsiteExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function pagesWebsiteBounds(
  input: PagesWebsiteBounds,
  zoom: number,
  content: { width: number; height: number },
) {
  if (!Number.isFinite(zoom) || zoom <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(content.width, Math.max(0, Math.round(input.x * zoom)));
  const y = Math.min(content.height, Math.max(0, Math.round(input.y * zoom)));
  const right = Math.min(content.width, Math.max(x, Math.round((input.x + input.width) * zoom)));
  const bottom = Math.min(content.height, Math.max(y, Math.round((input.y + input.height) * zoom)));
  return { x, y, width: right - x, height: bottom - y };
}
