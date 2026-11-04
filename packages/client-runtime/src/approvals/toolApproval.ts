import { findHtmlRenderLocalImages } from "@starkfuture/shared/htmlRender";
import { resolveStarkMcpToolId } from "@starkfuture/shared/starkMcpToolPresentation";

import { toolCallLines } from "../work-log/itemDetail.ts";

/**
 * What a non-shell tool approval card says about the call it gates. Only
 * Stark's own HTML tools get a described effect; every other tool is named and
 * its arguments shown, never explained. Nothing here reads the files a call
 * names or renders its page: the text scan below is all the evidence used.
 */
export interface ToolApprovalPresentation {
  readonly kind: "html-render" | "html-preview" | "tool";
  readonly headline: string;
  /** What the call does and touches, in reading order; `files` lists the paths a line names. */
  readonly scope: ReadonlyArray<{ readonly text: string; readonly files?: ReadonlyArray<string> }>;
  /**
   * Local files the page names that the server would read and embed. `null`
   * while the full arguments are unknown, so a partial list never reads as complete.
   */
  readonly localImages: ReadonlyArray<string> | null;
  /** Every argument as `key value`, or formatted text when they are not flat. */
  readonly argumentLines: ReadonlyArray<readonly [string, string]> | null;
  readonly argumentText: string | null;
  /** The arguments are only a preview; the full call must load before it can be reviewed. */
  readonly argumentsIncomplete: boolean;
}

// WireProjection's markers for a value too large to send whole.
const TRANSPORT_TRUNCATION_MARKER = "\n… output truncated for transport";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The timeline sends a large input as `{ summary, truncated: true }`; the detail read sends it whole. */
export function isToolInputSummarized(
  input: unknown,
): input is { readonly summary: string; readonly truncated: true } {
  return isRecord(input) && input.truncated === true && typeof input.summary === "string";
}

function isInputCut(input: unknown): boolean {
  return (
    isToolInputSummarized(input) ||
    (typeof input === "string" && input.endsWith(TRANSPORT_TRUNCATION_MARKER))
  );
}

function mcpToolParts(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const NETWORK_SCOPE =
  "The page's network requests are blocked by its content security policy; its scripts run when Stark draws it.";

export function presentToolApproval(input: {
  readonly toolName: string;
  readonly input: unknown;
}): ToolApprovalPresentation {
  const incomplete = isInputCut(input.input);
  const lines = incomplete ? { args: null, argsText: null } : toolCallLines({ args: input.input });
  const base = {
    argumentLines: lines.args,
    argumentText: lines.argsText,
    argumentsIncomplete: incomplete,
  };
  const starkTool = resolveStarkMcpToolId(input.toolName);
  if (starkTool === "html_render" || starkTool === "html_preview") {
    const args = isRecord(input.input) && !incomplete ? input.input : null;
    const html = typeof args?.html === "string" ? args.html : null;
    const localImages =
      html === null
        ? null
        : [...new Set(findHtmlRenderLocalImages(html).map((reference) => reference.path))];
    // Publishing refuses a page with an unreadable image; a preview leaves it out.
    const imageScope =
      localImages === null
        ? "Which local files the page names is shown once its full arguments load."
        : localImages.length === 0
          ? "The page names no local files."
          : `Reads ${plural(localImages.length, "local image")} named in the page and embeds ${
              localImages.length === 1 ? "it" : "them"
            }. ${
              starkTool === "html_render"
                ? "A file that is not an image, or cannot be read, fails the call."
                : "A file that is not an image, or cannot be read, is left out."
            }`;
    const images = { text: imageScope, ...(localImages?.length ? { files: localImages } : {}) };
    if (starkTool === "html_render") {
      const title = typeof args?.title === "string" && args.title.trim() ? args.title.trim() : null;
      const height = typeof args?.height === "number" ? args.height : null;
      return {
        ...base,
        kind: "html-render",
        headline: title
          ? `Show the HTML page “${title}” in this chat`
          : "Show an HTML page in this chat",
        scope: [
          {
            text: `Saves the page to this thread and shows it inline${
              height === null ? "" : ` in a frame up to ${height}px tall`
            }.`,
          },
          images,
          { text: NETWORK_SCOPE },
        ],
        localImages,
      };
    }
    return {
      ...base,
      kind: "html-preview",
      headline: "Preview an HTML page in Stark's headless browser",
      scope: [
        {
          text: "Returns a screenshot and the page's console output to the agent. Nothing is added to this thread.",
        },
        images,
        { text: NETWORK_SCOPE },
      ],
      localImages,
    };
  }
  const parts = mcpToolParts(input.toolName);
  return {
    ...base,
    kind: "tool",
    headline: parts ? `Use “${parts.tool}” from ${parts.server}` : `Use ${input.toolName}`,
    scope: [
      { text: "This app can't tell what this tool does. Review its arguments before deciding." },
    ],
    localImages: null,
  };
}

/**
 * The provider's own request text, when it says more than the card already
 * does. Adapters that only restate the tool name and arguments add nothing.
 */
export function toolApprovalNote(prompt: string | undefined, toolName: string): string | null {
  const note = prompt?.trim();
  if (!note || note === toolName || note.startsWith(`${toolName}:`)) return null;
  const starkTool = resolveStarkMcpToolId(toolName);
  if (
    (starkTool === "html_render" && note.startsWith("Render an HTML page")) ||
    (starkTool === "html_preview" && note === "Preview an HTML page")
  ) {
    return null;
  }
  return note;
}
