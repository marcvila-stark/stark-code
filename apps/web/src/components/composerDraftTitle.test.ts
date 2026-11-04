import { ChatAttachmentId, ProviderInstanceId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveChatDisplayTitle, resolveComposerDraftTitle } from "./composerDraftTitle";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const skills = [
  { name: "plain-english", path: "/skills/plain/SKILL.md", enabled: true },
  { name: "review", path: "/skills/review/SKILL.md", enabled: true },
];
const providers = [
  {
    instanceId: codex,
    skills,
    workspaceSnapshots: [
      {
        cwd: "/project",
        checkedAt: "2026-10-27T00:00:00.000Z",
        slashCommands: [],
        skills: [...skills, { name: "project-audit", path: "/project/SKILL.md", enabled: true }],
      },
    ],
  },
  { instanceId: claude, skills: [] },
];

function composer(prompt: string) {
  return {
    prompt,
    activeProvider: codex,
    images: [],
    persistedAttachments: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  };
}

describe("composer draft display titles", () => {
  it("omits known leading skills while preserving the saved payload exactly", () => {
    const draft = Object.freeze(composer("$plain-english /review Explain this.\nMore context"));
    expect(resolveComposerDraftTitle({ composer: draft, providers })).toBe("Explain this.");
    expect(draft.prompt).toBe("$plain-english /review Explain this.\nMore context");
  });

  it("uses New draft for known skill-only or empty drafts", () => {
    for (const prompt of ["$plain-english", "$plain-english ", " /review\n", ""]) {
      expect(resolveComposerDraftTitle({ composer: composer(prompt), providers })).toBe(
        "New draft",
      );
    }
  });

  it("preserves literal dollars, unknown commands and non-leading skill mentions", () => {
    for (const prompt of [
      "$5 budget",
      "$HOME/settings",
      "$unavailable Explain this",
      "Use $plain-english here",
      "`$plain-english` Explain",
      "$plain-englishish Explain",
    ]) {
      expect(resolveComposerDraftTitle({ composer: composer(prompt), providers })).toBe(prompt);
    }
  });

  it("does not strip provider-looking commands from a shell draft", () => {
    expect(
      resolveComposerDraftTitle({
        composer: { ...composer("$review files"), shellMode: true },
        providers,
      }),
    ).toBe("$review files");
  });

  it("resolves context reference labels after omitting skill tokens", () => {
    expect(
      resolveComposerDraftTitle({
        composer: composer("$plain-english Explain [REVIEW.md](stark-context://v1/file/review-1)"),
        providers,
      }),
    ).toBe("Explain REVIEW.md");
  });

  it("uses the selected provider and exact workspace catalog only", () => {
    expect(
      resolveComposerDraftTitle({
        composer: { ...composer("$plain-english Explain"), activeProvider: claude },
        providers,
      }),
    ).toBe("$plain-english Explain");
    expect(
      resolveComposerDraftTitle({
        composer: composer("$project-audit Explain"),
        providers,
        cwd: "/project",
      }),
    ).toBe("Explain");
    expect(
      resolveComposerDraftTitle({
        composer: composer("$project-audit Explain"),
        providers,
        cwd: "/another-project",
      }),
    ).toBe("$project-audit Explain");
    expect(
      resolveComposerDraftTitle({ composer: composer("$plain-english Explain"), providers: [] }),
    ).toBe("$plain-english Explain");
  });

  it("shows the attachment fallback without counting rehydrated images twice", () => {
    const draft = composer("$plain-english ");
    const image = {
      type: "image" as const,
      id: ChatAttachmentId.make("draft-image"),
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:diagram",
      file: new File(["png"], "diagram.png", { type: "image/png" }),
    };
    const imageDraft = {
      ...draft,
      images: [image],
      persistedAttachments: [{ ...image, dataUrl: "data:image/png;base64,cG5n" }],
    };
    expect(resolveComposerDraftTitle({ composer: imageDraft, providers })).toBe("1 attachment");
  });
});

it("uses the same display projection for sent titles and preserves their source", () => {
  const title = "$plain-english Explain this result";
  expect(resolveChatDisplayTitle({ title, providers, providerInstanceId: codex })).toBe(
    "Explain this result",
  );
  expect(title).toBe("$plain-english Explain this result");
});
