export interface StarkPagesMirror {
  readonly port: number;
  readonly root: string;
}

/** The mirror accepts exact custom-scheme origins through this documented env setting. */
export const STARK_PAGES_ENV = {
  SPAGE_EMBED_ORIGINS: "starkcode://app starkcode-dev://app",
} as const;

function isStarkPagesPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 4317 && port <= 4337;
}

function parseLink(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isMirrorFollowUrl(raw: unknown, port: number): raw is string {
  const url = parseLink(raw);
  return (
    url !== null &&
    isStarkPagesPort(port) &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    Number(url.port) === port &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/follow" &&
    url.hash === "" &&
    /^[a-z0-9-]{3,64}$/.test(url.searchParams.get("slug") ?? "") &&
    [...url.searchParams.keys()].every((key) => key === "slug")
  );
}

export function isOpenableStarkPageLink(raw: unknown): raw is string {
  const url = parseLink(raw);
  return (
    url !== null &&
    ["http:", "https:"].includes(url.protocol) &&
    url.username === "" &&
    url.password === ""
  );
}

export function isStarkPagesPanelUrl(raw: unknown): raw is string {
  const url = parseLink(raw);
  return (
    url !== null &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    isStarkPagesPort(Number(url.port)) &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/panel"
  );
}

export type StarkPagesPanelMessage =
  | { readonly type: "ready"; readonly root: string; readonly port: number }
  | {
      readonly type: "show" | "publish-request";
      readonly page: { readonly slug: string; readonly title: string };
    }
  | { readonly type: "open-external" | "open-link"; readonly url: string };

export function parseStarkPagesMessage(raw: unknown): StarkPagesPanelMessage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (Reflect.get(raw, "v") !== 1 || Reflect.get(raw, "source") !== "stark-pages") return null;
  const type = Reflect.get(raw, "type");
  if (type === "ready") {
    const root = Reflect.get(raw, "root");
    const port = Reflect.get(raw, "port");
    return typeof root === "string" && root.length <= 4096 && isStarkPagesPort(port)
      ? { type, root, port }
      : null;
  }
  if (type === "show" || type === "publish-request") {
    const page = Reflect.get(raw, "page");
    if (typeof page !== "object" || page === null) return null;
    const slug = Reflect.get(page, "slug");
    const title = Reflect.get(page, "title");
    return typeof slug === "string" &&
      /^[a-z0-9-]{3,64}$/.test(slug) &&
      typeof title === "string" &&
      title.length <= 200
      ? { type, page: { slug, title } }
      : null;
  }
  if (type === "open-external" || type === "open-link") {
    const url = Reflect.get(raw, "url");
    return typeof url === "string" && url.length <= 2048 ? { type, url } : null;
  }
  return null;
}
