import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionImportResult,
  AgentSessionScanResult,
  agentSessionImportThreadId,
  parseAgentSessionImportThreadId,
} from "./agentSessions.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);
const decodeImportResult = Schema.decodeSync(AgentSessionImportResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/example/stark-code", repository: "example/stark-code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

describe("agent session import thread ids", () => {
  it("round-trips the instance and the native session", () => {
    const providerInstanceId = ProviderInstanceId.make("claude_work");
    const providerSessionId = "6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f";
    const threadId = agentSessionImportThreadId({ providerInstanceId, providerSessionId });

    expect(threadId).toBe(`import:claude_work:${providerSessionId}`);
    expect(parseAgentSessionImportThreadId(threadId)).toEqual({
      providerInstanceId,
      providerSessionId,
    });
  });

  it("keeps colons that belong to the native session id", () => {
    expect(parseAgentSessionImportThreadId("import:codex:rollout:2026")).toEqual({
      providerInstanceId: "codex",
      providerSessionId: "rollout:2026",
    });
  });

  it("does not claim threads that were not imported from a CLI", () => {
    expect(parseAgentSessionImportThreadId("thread-123")).toBeNull();
    expect(parseAgentSessionImportThreadId("import:")).toBeNull();
    expect(parseAgentSessionImportThreadId("import:codex:")).toBeNull();
    expect(parseAgentSessionImportThreadId("import::session")).toBeNull();
    expect(parseAgentSessionImportThreadId("import:9codex:session")).toBeNull();
  });
});

describe("AgentSessionImportResult", () => {
  it("decodes results from servers that do not report already imported sessions", () => {
    const result = decodeImportResult({
      importedCount: 2,
      skippedCount: 1,
    });

    expect(result.alreadyImportedCount).toBeUndefined();
    expect(result.alreadyRunByStarkCount).toBeUndefined();
  });
});
