import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveConnectedToolsAgent } from "./mcpServersSettings.logic";

const provider = (
  driver: string,
  status: ServerProvider["status"] = "ready",
  instanceId = driver,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status,
  auth: { status: status === "ready" ? "authenticated" : "unauthenticated" },
  checkedAt: "2026-10-28T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("resolveConnectedToolsAgent", () => {
  it("opens on Claude and lists it first when it is ready", () => {
    const { agents, agent } = resolveConnectedToolsAgent(
      [provider("codex"), provider("cursor"), provider("claudeAgent")],
      null,
    );

    expect(agents.map((entry) => entry.instanceId)).toEqual(["claudeAgent", "codex"]);
    expect(agent?.instanceId).toBe("claudeAgent");
  });

  it("opens on a ready agent when Claude is signed out", () => {
    const { agent } = resolveConnectedToolsAgent(
      [provider("codex"), provider("claudeAgent", "error")],
      null,
    );

    expect(agent?.instanceId).toBe("codex");
  });

  it("keeps the agent the user chose", () => {
    const { agent } = resolveConnectedToolsAgent(
      [provider("codex"), provider("claudeAgent")],
      ProviderInstanceId.make("codex"),
    );

    expect(agent?.instanceId).toBe("codex");
  });
});
