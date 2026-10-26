/** Keep a complete UTF-8 prefix; never split a multibyte character. */
export function truncateNativeReplyText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= 131_072) return { text, truncated: false };
  let end = 131_072;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Written into private app state so packaged and source launches use the same hook. */
export const nativeReplyHookSource = String.raw`"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const truncateReply = ${truncateNativeReplyText.toString()};
const projectEvidence = ${projectNativeTurnEvidence.toString()};
const readEvidence = hook => {
  const empty = {coverage:"unavailable",commands:[],changes:[],unconfirmedChanges:0};
  let descriptor;
  try {
    const provider = process.env.STARK_NATIVE_REPLY_PROVIDER;
    if (!["claude","codex"].includes(provider) || typeof hook.transcript_path !== "string" ||
        typeof hook.cwd !== "string" || !/^[a-zA-Z0-9-]{1,256}$/.test(hook.session_id)) return empty;
    const configured = provider === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
    const home = configured || path.join(os.homedir(), provider === "codex" ? ".codex" : ".claude");
    const root = fs.realpathSync(path.join(home, provider === "codex" ? "sessions" : "projects"));
    const filename = fs.realpathSync(hook.transcript_path);
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith(".." + path.sep) || relative === ".." ||
        path.isAbsolute(relative) || !filename.endsWith(provider === "codex"
          ? "-" + hook.session_id + ".jsonl" : path.sep + hook.session_id + ".jsonl")) return empty;
    const before = fs.statSync(filename);
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return empty;
    // A Stop hook reads a bounded snapshot, not an ongoing watcher or another
    // session. Never copy the transcript, reasoning, tool output or patch bodies.
    const limit = 4194304;
    const start = Math.max(0, stat.size - limit);
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    const size = fs.readSync(descriptor, bytes, 0, bytes.length, start);
    let source = bytes.subarray(0, size).toString("utf8");
    if (start) source = source.slice(source.indexOf("\n") + 1);
    const records = [];
    let truncated = start > 0;
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      if (records.length >= 10000 || Buffer.byteLength(line) > 1048576) { truncated = true; continue; }
      try { records.push(JSON.parse(line)); } catch { truncated = true; }
    }
    if (provider === "codex") {
      const header = Buffer.alloc(Math.min(stat.size, 131072));
      const count = fs.readSync(descriptor, header, 0, header.length, 0);
      const first = JSON.parse(header.subarray(0,count).toString("utf8").split("\n")[0]);
      if (first.type !== "session_meta" ||
          (first.payload?.session_id ?? first.payload?.id) !== hook.session_id) return empty;
    }
    return projectEvidence({provider,sessionId:hook.session_id,turnId:hook.turn_id ?? null,
      replyText:hook.last_assistant_message,cwd:hook.cwd,records,truncated});
  } catch { return empty; }
  finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} } }
};
let input = "";
let bytes = 0;
let oversized = false;
let finished = false;
const finish = () => { if (!finished) { finished = true; process.stdout.write("{}\n"); } };
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 8388608) { oversized = true; input = ""; }
  else if (!oversized) input += chunk;
});
process.stdin.on("error", finish);
process.stdin.on("end", () => {
  try {
    if (oversized) return finish();
    const hook = JSON.parse(input);
    if (hook.agent_id || typeof hook.session_id !== "string" || !hook.session_id) return finish();
    const kind = hook.hook_event_name === "Notification"
      ? hook.notification_type === "permission_prompt" ? "permission"
        : hook.notification_type === "elicitation_dialog" ? "question" : null
      : hook.hook_event_name === "UserPromptSubmit" || hook.hook_event_name === "Stop" ? "clear" : null;
    if (kind === null) return finish();
    const endpoint = new URL(process.env.STARK_NATIVE_REPLY_ENDPOINT || "");
    const token = process.env.STARK_NATIVE_REPLY_TOKEN || "";
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
        endpoint.pathname !== "/native-replies" || endpoint.search || endpoint.hash ||
        endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/.test(token)) return finish();
    const attentionOnly = process.argv.includes("--attention-only");
    const reply = !attentionOnly && hook.hook_event_name === "Stop" && typeof hook.last_assistant_message === "string" &&
      hook.last_assistant_message.trim() ? truncateReply(hook.last_assistant_message) : null;
    if (hook.hook_event_name === "Stop" && !attentionOnly && !reply) return finish();
    const body = JSON.stringify(reply ? {
      deliveryId: crypto.randomUUID(), hook_event_name: hook.hook_event_name,
      session_id: hook.session_id, turn_id: hook.turn_id ?? null,
      last_assistant_message: reply.text, truncated: reply.truncated,
      evidence: readEvidence(hook),
      stop_hook_active: hook.stop_hook_active === true, occurred_at: Date.now()
    } : {
      deliveryId: crypto.randomUUID(), hook_event_name: hook.hook_event_name,
      session_id: hook.session_id, attention: kind, occurred_at: Date.now()
    });
    let attempts = 0;
    const send = () => {
      const request = http.request(endpoint, { method: "POST", headers: {
        authorization: "Bearer " + token, "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      } }, response => { response.resume(); response.on("end", finish); response.on("error", finish); });
      request.on("error", () => { if (++attempts < 2) send(); else finish(); });
      request.setTimeout(2000, () => request.destroy());
      request.end(body);
    };
    send();
  } catch { finish(); }
});
`;

export function nativeReplyHookCommand(input: {
  readonly nodeExecutable: string;
  readonly scriptPath: string;
  readonly platform: NodeJS.Platform;
  readonly provider: "claude" | "codex";
}): string {
  if (input.platform === "win32" && input.provider === "codex") {
    // Codex invokes Windows command hooks through COMSPEC/cmd.exe. Encoding the
    // PowerShell command keeps %, !, quotes and shell syntax in paths literal.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(input.nodeExecutable)} ${quote(input.scriptPath)}; exit $LASTEXITCODE`;
    return `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const shellPath = (value: string) =>
    input.platform === "win32" ? value.replaceAll("\\", "/") : value;
  return `ELECTRON_RUN_AS_NODE=1 ${quote(shellPath(input.nodeExecutable))} ${quote(shellPath(input.scriptPath))}`;
}
import { projectNativeTurnEvidence } from "./NativeTurnEvidence.ts";
