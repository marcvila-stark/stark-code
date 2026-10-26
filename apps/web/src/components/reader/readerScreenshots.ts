import type { Root, RootContent, PhrasingContent, Paragraph } from "mdast";
import {
  fileBasename,
  isAbsolutePath,
  isWindowsAbsolutePath,
  workspaceRelativeFilePath,
} from "@starkfuture/shared/path";

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|svg)$/i;
const MAX_SCREENSHOTS = 12;

/** Only infer workspace files. The signed workspace asset also checks canonical paths,
 * so a symlink cannot turn a harmless-looking screenshot into an outside file read. */
export function readerScreenshotPath(candidate: string, cwd: string | undefined): string | null {
  if (!cwd || !candidate || candidate.length > 1024 || !IMAGE_EXTENSION.test(candidate))
    return null;
  // oxlint-disable-next-line no-control-regex -- inferred paths must not carry control characters.
  if (/[\x00-\x1f<>|?*#]/.test(candidate) || candidate.startsWith("~")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !isWindowsAbsolutePath(candidate)) return null;
  if (candidate.startsWith("//")) return null;
  const relative = isAbsolutePath(candidate)
    ? workspaceRelativeFilePath(candidate, cwd)
    : candidate;
  if (relative === null) return null;
  const parts: string[] = [];
  for (const part of relative.replaceAll("\\", "/").split("/")) {
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/** Quotes/backticks may carry spaces. Unquoted prose must contain a whole filename,
 * not the tail of a URL, an email address, a source expression, or a fenced example. */
function proseCandidates(value: string): string[] {
  const candidates: string[] = [];
  const remaining = value.replace(
    /(^|[\s([{])(["'])([^\n]*?)\2/g,
    (_match, prefix: string, _quote, path: string) => {
      candidates.push(path);
      return `${prefix} `;
    },
  );
  for (const token of remaining.split(/\s+/)) {
    const path = token.replace(/^[([{]+/, "").replace(/[.,;:!?\])}]+$/, "");
    if (!path.includes("@") && !/[=<>"'`]/.test(path)) candidates.push(path);
  }
  return candidates;
}

function paragraphCandidates(children: readonly PhrasingContent[]): string[] {
  return children.flatMap((child) => {
    if (child.type === "inlineCode") return [child.value];
    if (child.type === "text") return proseCandidates(child.value);
    if (child.type === "link") return [child.url];
    if (child.type === "strong" || child.type === "emphasis" || child.type === "delete") {
      return paragraphCandidates(child.children);
    }
    return [];
  });
}

/** Add previews beside the prose that names them, without changing the original answer.
 * Authored Markdown images retain their normal media behavior and never get duplicated. */
export function remarkReaderScreenshots(options: { readonly cwd: string }) {
  return (tree: Root) => {
    const key = (path: string) => (isWindowsAbsolutePath(options.cwd) ? path.toLowerCase() : path);
    const seen = new Set<string>();
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: Root | RootContent) => {
      if (node.type === "definition") definitions.set(node.identifier, node.url);
      if ("children" in node) node.children.forEach(collectDefinitions);
    };
    collectDefinitions(tree);
    const collectImages = (node: Root | RootContent) => {
      const url =
        node.type === "image"
          ? node.url
          : node.type === "imageReference"
            ? definitions.get(node.identifier)
            : undefined;
      const path = url ? readerScreenshotPath(url, options.cwd) : null;
      if (path) seen.add(key(path));
      if ("children" in node) node.children.forEach(collectImages);
    };
    collectImages(tree);
    let added = 0;
    const appendPreviews = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      // Only block containers may gain new paragraphs. Code, HTML, links, and table
      // cells keep their authored contents; screenshots in normal lists still work.
      if (node.type !== "root" && node.type !== "blockquote" && node.type !== "listItem") {
        node.children.forEach(appendPreviews);
        return;
      }
      const children = [];
      for (const child of node.children) {
        children.push(child);
        if (child.type !== "paragraph") {
          appendPreviews(child);
          continue;
        }
        for (const candidate of paragraphCandidates(child.children)) {
          const path = readerScreenshotPath(candidate, options.cwd);
          if (!path || seen.has(key(path)) || added >= MAX_SCREENSHOTS) continue;
          seen.add(key(path));
          added += 1;
          const preview: Paragraph = {
            type: "paragraph",
            children: [
              {
                type: "image",
                url: path,
                alt: fileBasename(path),
                data: { hProperties: { dataReaderScreenshot: "workspace-file" } },
              },
            ],
          };
          children.push(preview);
        }
      }
      // These containers have compatible block children; the traversal never adds
      // an inline node or modifies the source nodes/positions used by copy and find.
      node.children = children as typeof node.children;
    };
    appendPreviews(tree);
  };
}
