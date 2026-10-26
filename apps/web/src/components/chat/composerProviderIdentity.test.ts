import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@starkfuture/contracts";
import { composerAccountIdentity, composerProviderIdentity } from "./composerProviderIdentity";

function provider(
  driver: string,
  displayName: string,
  auth: ServerProvider["auth"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`${driver}_work`),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth,
    checkedAt: "2026-10-19T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("composerProviderIdentity", () => {
  it("identifies OpenRouter separately from the Claude runtime, including renamed connections", () => {
    const openRouter = {
      ...provider("claudeAgent", "Team API", { status: "authenticated", type: "apiKey" }),
      apiBackend: "openrouter" as const,
    };
    expect(composerProviderIdentity(openRouter)).toBe("OpenRouter · Team API");
    expect(composerAccountIdentity(openRouter)).toBe("OpenRouter · Team API");
  });
  it("shows a named profile while keeping subscription boilerplate out of the composer", () => {
    expect(
      composerAccountIdentity(
        provider("claudeAgent", "Claude", {
          status: "authenticated",
          label: "Claude Team Subscription",
        }),
      ),
    ).toBeNull();
    expect(
      composerAccountIdentity(
        provider("codex", "Codex", {
          status: "authenticated",
          label: "ChatGPT Pro 20x Subscription",
        }),
      ),
    ).toBeNull();
    expect(
      composerAccountIdentity(
        provider("claudeAgent", "Stark Future 2", { status: "authenticated" }),
      ),
    ).toBe("Claude · Stark Future 2");
  });
  it("keeps the selected provider alongside its reported profile", () => {
    expect(
      composerProviderIdentity(
        provider("claudeAgent", "Stark Future 1", { status: "authenticated" }),
      ),
    ).toBe("Claude · Stark Future 1");
    expect(
      composerProviderIdentity(provider("codex", "Personal", { status: "authenticated" })),
    ).toBe("Codex · Personal");
  });
  it("uses the auth label when the default profile has no account name, without inventing an organization", () => {
    expect(
      composerProviderIdentity(
        provider("codex", "Codex", {
          status: "authenticated",
          label: "ChatGPT Team",
          workspaceId: "opaque-workspace-id",
        }),
      ),
    ).toBe("Codex · ChatGPT Team");
    expect(
      composerProviderIdentity(
        provider("claudeAgent", "Claude", { status: "authenticated", email: "person@example.com" }),
      ),
    ).toBe("Claude");
  });
  it("does not repeat the provider name or expose stale signed-out account details", () => {
    expect(
      composerProviderIdentity(
        provider("codex", "Codex", { status: "authenticated", label: "Codex" }),
      ),
    ).toBe("Codex");
    expect(
      composerProviderIdentity(
        provider("codex", "Codex", {
          status: "unauthenticated",
          label: "Old account",
          email: "person@example.com",
        }),
      ),
    ).toBe("Codex");
  });
});
