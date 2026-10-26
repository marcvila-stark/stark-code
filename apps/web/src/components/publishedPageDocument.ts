import createDOMPurify from "dompurify";
import { generate, ident, parse, walk } from "css-tree";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";
import { MAX_PAGE_QUOTE_LENGTH } from "../starkPageQuote";

type PageLocation = Pick<StarkPublishedPageDocument, "root" | "path">;
const pagesOrigin = "https://pages.starkfuture.com";

function pageUrl(location: PageLocation, path = location.path) {
  return `${pagesOrigin}/${encodeURIComponent(location.root)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function localPath(raw: string, location: PageLocation, base = location.path): string | null {
  try {
    const prefix = `/${encodeURIComponent(location.root)}/`;
    const reference =
      raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith(prefix)
        ? `${prefix}${raw.slice(1)}`
        : raw;
    const url = new URL(reference, pageUrl(location, base));
    if (
      url.origin !== pagesOrigin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(prefix)
    )
      return null;
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (path.split("/").some((part) => part === "." || part === "..") || /[\\\0]/.test(path))
      return null;
    return path;
  } catch {
    return null;
  }
}

/** Only HTML pages in this project are routed back through the authenticated Pages reader. */
export function publishedPageLink(raw: string, location?: PageLocation) {
  if (raw.startsWith("#")) return { kind: "anchor" as const, url: raw };
  try {
    const url = location ? new URL(raw, pageUrl(location)) : new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // Navigation follows normal URL semantics; project-root shorthand is only for assets.
    const path = location ? localPath(url.href, location) : null;
    if (path !== null && (path.endsWith("/") || path === "" || /\.html?$/i.test(path)))
      return {
        kind: "page" as const,
        path: path.endsWith("/") || !path ? `${path}index.html` : path,
      };
    return { kind: "external" as const, url: url.href };
  } catch {
    return null;
  }
}

export function publishedHtmlDocument(html: string, bundle?: StarkPublishedPageDocument): string {
  return preparePublishedHtml(html, bundle).html;
}

/** Offline document with one trusted link bridge. Page scripts and remote resources never run. */
export function preparePublishedHtml(html: string, bundle?: StarkPublishedPageDocument) {
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- Synchronous browser CSP nonce for this isolated document.
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const assets = new Map(bundle?.assets.map((asset) => [asset.path, asset]));
  // A bounded input can expand enormously through repeated imports or image data URLs.
  // Budget work as well as output, before allocating repeated resource strings.
  let resourceBudget = 12 * 1024 * 1024;
  let cssBudget = 4 * 1024 * 1024;
  let cssCalls = 256;
  const warnings = new Set<string>();
  const limited = () =>
    warnings.add("Some repeated or large resources were omitted to keep this page responsive.");
  const assetAt = (url: string, base: string) => {
    const path = bundle ? localPath(url, bundle, base) : null;
    return path === null ? undefined : assets.get(path);
  };
  const resource = (url: string, base: string): string | null => {
    if (url.startsWith("#")) return url;
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/[a-z0-9-]+)[;,]/i.test(url))
      return url;
    const asset = assetAt(url, base);
    if (
      !asset ||
      !/^(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/[a-z0-9-]+|application\/(?:font-woff|vnd\.ms-fontobject))$/i.test(
        asset.mimeType,
      )
    )
      return null;
    const estimated = asset.content.length * (asset.encoding === "base64" ? 1 : 9) + 100;
    if (estimated > resourceBudget) {
      limited();
      return null;
    }
    resourceBudget -= estimated;
    return asset.encoding === "base64"
      ? `data:${asset.mimeType};base64,${asset.content}`
      : `data:${asset.mimeType};charset=utf-8,${encodeURIComponent(asset.content)}`;
  };
  const css = (source: string, base: string, ancestry = new Set<string>()): string => {
    if (ancestry.size > 8 || --cssCalls < 0 || source.length > cssBudget) {
      limited();
      return "";
    }
    cssBudget -= source.length;
    try {
      const tree = parse(source);
      if (tree.type !== "StyleSheet") return "";
      const result: string[] = [];
      tree.children.forEach((node) => {
        if (node.type === "Atrule" && ident.decode(node.name).toLowerCase() === "import") {
          const parts =
            node.prelude?.type === "AtrulePrelude" ? node.prelude.children.toArray() : [];
          const first = parts.shift();
          const asset =
            first && (first.type === "String" || first.type === "Url")
              ? assetAt(first.value, base)
              : undefined;
          if (
            !asset ||
            asset.mimeType !== "text/css" ||
            asset.encoding !== "utf8" ||
            ancestry.has(asset.path)
          )
            return;
          const nested = css(asset.content, asset.path, new Set([...ancestry, asset.path]));
          const media = parts
            .map((part) => generate(part))
            .join(" ")
            .trim();
          // Layer/supports imports need their cascade semantics; omit unsupported qualifiers.
          if (!media) result.push(nested);
          else if (/^(?:screen\b|print\b|all\b|not\b|only\b|\()/i.test(media))
            result.push(`@media ${media}{${nested}}`);
          return;
        }
        walk(node, (child) => {
          if (child.type === "Url") child.value = resource(child.value, base) ?? "data:,";
          if (child.type === "Function" && ident.decode(child.name).toLowerCase() === "url") {
            const argument = child.children.first;
            const value = argument?.type === "String" ? resource(argument.value, base) : null;
            Object.assign(child, { type: "Url", value: value ?? "data:," });
          }
        });
        result.push(generate(node));
      });
      return result.join("\n");
    } catch {
      return "";
    }
  };

  // DOMParser is inert: don't attach untrusted nodes to the application document.
  const source = new DOMParser().parseFromString(html, "text/html");
  const base = bundle?.path ?? "index.html";
  const resolvedStyles = new WeakSet<Element>();
  for (const link of source.querySelectorAll("link")) {
    const asset = link.rel.toLowerCase().split(/\s+/).includes("stylesheet")
      ? assetAt(link.getAttribute("href") ?? "", base)
      : undefined;
    if (asset?.mimeType === "text/css" && asset.encoding === "utf8") {
      const style = source.createElement("style");
      style.textContent = css(asset.content, asset.path, new Set([asset.path]));
      if (link.media) style.media = link.media;
      link.replaceWith(style);
      // Already rebased to this stylesheet, so avoid resolving it again below.
      resolvedStyles.add(style);
    } else link.remove();
  }
  for (const style of source.querySelectorAll("style")) {
    if (!resolvedStyles.has(style)) style.textContent = css(style.textContent ?? "", base);
  }
  for (const element of source.querySelectorAll("[style]")) {
    // A rule wrapper uses the same parser for declarations and stylesheet URLs.
    const rewritten = css(`x{${element.getAttribute("style")}}`, base);
    element.setAttribute(
      "style",
      rewritten.slice(rewritten.indexOf("{") + 1, rewritten.lastIndexOf("}")),
    );
  }
  for (const element of source.querySelectorAll("[src], [poster], [background], [srcset]")) {
    for (const name of ["src", "poster", "background"]) {
      const raw = element.getAttribute(name);
      if (raw === null) continue;
      const resolved = resource(raw, base);
      if (resolved) element.setAttribute(name, resolved);
      else element.removeAttribute(name);
    }
    const candidates = element.getAttribute("srcset");
    if (candidates && !element.hasAttribute("src")) {
      for (const candidate of candidates.split(",")) {
        const resolved = resource(candidate.trim().split(/\s+/)[0] ?? "", base);
        if (resolved) {
          element.setAttribute("src", resolved);
          break;
        }
      }
    }
    element.removeAttribute("srcset");
  }
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "href" && node.nodeName.toLowerCase() === "a") {
      const link = publishedPageLink(data.attrValue, bundle);
      if (link) {
        node.setAttribute("data-stark-link", data.attrValue);
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "link");
      }
      data.keepAttr = false;
    }
  });
  const clean = purifier.sanitize(source.documentElement.outerHTML, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "base",
      "meta",
      "link",
      "audio",
      "video",
      "source",
      "animate",
      "set",
    ],
    FORBID_ATTR: [
      "srcdoc",
      "href",
      "xlink:href",
      "target",
      "ping",
      "download",
      "autofocus",
      "nonce",
    ],
  });
  const output = new DOMParser().parseFromString(clean, "text/html");
  // Only this bridge runs. The host checks the frame's opaque origin and validates the link again.
  const bridge = output.createElement("script");
  bridge.setAttribute("nonce", nonce);
  bridge.textContent = `function send(message){parent.postMessage({source:'stark-published-page',...message},${JSON.stringify(window.location.origin)});}function open(e){const a=e.target.closest?.('a[data-stark-link]');if(!a)return;e.preventDefault();const u=a.getAttribute('data-stark-link');if(u?.startsWith('#')){try{document.getElementById(decodeURIComponent(u.slice(1)))?.scrollIntoView();}catch{}return;}send({type:'open-link',url:u});}document.addEventListener('click',open);document.addEventListener('keydown',e=>{if(e.key==='Enter')open(e);if(e.key==='Escape'&&!e.defaultPrevented&&!e.isComposing&&!e.repeat&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey)send({type:'exit-expanded'});});`;
  bridge.textContent += `function selection(){const s=window.getSelection();const text=s&&!s.isCollapsed?s.toString():'';send({type:'selection',selectionToken:${JSON.stringify(nonce)},text:text.length<=${MAX_PAGE_QUOTE_LENGTH}?text:'',tooLong:text.length>${MAX_PAGE_QUOTE_LENGTH}});}document.addEventListener('pointerup',selection);document.addEventListener('keyup',selection);`;
  const csp = output.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const fallback = output.createElement("style");
  // Original page styles follow these defaults and retain their cascade and root/body selectors.
  const unstyled = ![...output.querySelectorAll("style")].some((style) =>
    style.textContent?.trim(),
  );
  fallback.textContent = `${unstyled ? "body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:20px;color:#202124;overflow-wrap:anywhere}" : ""}img{max-width:100%;height:auto}pre{overflow:auto}table{max-width:100%}a[data-stark-link]{cursor:pointer}`;
  output.head.prepend(csp, fallback);
  output.body.append(bridge);
  return {
    html: `<!doctype html>${output.documentElement.outerHTML}`,
    warnings: [...warnings],
    selectionToken: nonce,
  };
}
