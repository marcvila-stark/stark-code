export type NativeMcpWarning = "connection" | "sign-in";

const MAX_LINE_PREFIX = 512;

function classifyWarning(line: string): NativeMcpWarning | undefined {
  // A discovery/startup failure says nothing about the task's needs. Only
  // promote an explicit Claude tool-result error; unstructured Codex status
  // lines remain in the terminal, where Connection help is always available.
  const resultPrefix = /^\s*⎿\s+Error:\s*/;
  if (!resultPrefix.test(line)) return undefined;
  const message = line.replace(resultPrefix, "");
  if (
    /^MCP server "[^"\r\n]{1,256}" needs authentication[.!]?$/.test(message) ||
    /^MCP server "[^"\r\n]{1,256}" rejected the session credential \(HTTP (?:401|403)\)$/.test(
      message,
    ) ||
    message === "MCP server needs authentication on this machine" ||
    message === "MCP authentication required. Reconnect to continue using this server."
  )
    return "sign-in";
  if (/^MCP server "[^"\r\n]{1,256}" is not connected(?::|$)/.test(message)) return "connection";
  return undefined;
}

/** Passive, bounded parsing only. No terminal writes, endpoint data, or error logs. */
export function createNativeMcpWarningDetector() {
  let line = "";
  let discardingLine = false;
  let inFence = false;
  let escape: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  let reported: NativeMcpWarning | undefined;

  return {
    read(chunk: string, reset = false): NativeMcpWarning | undefined {
      if (reset) {
        line = "";
        discardingLine = false;
        inFence = false;
        escape = "text";
        reported = undefined;
      }
      let found: NativeMcpWarning | undefined;
      const inspect = () => {
        if (inFence || discardingLine) return;
        const warning = classifyWarning(line);
        if (warning === undefined) return;
        // Once classified, discard the line rather than retaining server
        // names, URLs, or the diagnostic suffix. Auth takes precedence.
        line = "";
        discardingLine = true;
        if (reported === "sign-in" || warning === reported) return;
        reported = warning;
        found = warning;
      };
      for (const character of chunk) {
        if (escape === "escape") {
          escape = character === "[" ? "csi" : "]P^_".includes(character) ? "string" : "text";
          continue;
        }
        if (escape === "csi") {
          if (character >= "@" && character <= "~") escape = "text";
          continue;
        }
        if (escape === "string" || escape === "string-escape") {
          if (character === "\u0007" || (escape === "string-escape" && character === "\\"))
            escape = "text";
          else escape = character === "\u001b" ? "string-escape" : "string";
          continue;
        }
        if (character === "\u001b") {
          escape = "escape";
          continue;
        }
        if (character === "\n" || character === "\r") {
          inspect();
          if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
          line = "";
          discardingLine = false;
          continue;
        }
        if (discardingLine || character < " ") continue;
        if (line.length >= MAX_LINE_PREFIX) {
          inspect();
          line = "";
          discardingLine = true;
          continue;
        }
        line += character;
      }
      // Ink/ratatui status rows can be repainted without a trailing newline.
      inspect();
      // Attaching to a running terminal replays old output. Keep its parsing
      // context, but never turn that history into a new task warning.
      if (reset) {
        reported = undefined;
        return undefined;
      }
      return found;
    },
  };
}
