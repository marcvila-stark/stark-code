import type { ServerProvider, ServerProviderSkill } from "@starkfuture/contracts";
import { replaceComposerContextReferences } from "@starkfuture/shared/composerContextReferences";
import type { ComposerThreadDraftState } from "../composerDraftStore";
import { splitAttachedSkills } from "./composerAttachedSkills";
import { rememberedTitleSkills } from "./titleSkillCatalog";

type TitleProvider = Pick<ServerProvider, "instanceId" | "skills" | "workspaceSnapshots">;

function titleSkills(input: {
  providers: readonly TitleProvider[];
  providerInstanceId: string | null | undefined;
  cwd?: string | null | undefined;
  environmentId?: string | null | undefined;
}): readonly Pick<ServerProviderSkill, "name">[] {
  const provider = input.providers.find((item) => item.instanceId === input.providerInstanceId);
  const remembered = rememberedTitleSkills(
    input.environmentId,
    input.providerInstanceId,
    input.cwd,
  );
  const live =
    provider?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd)?.skills ??
    provider?.skills ??
    [];
  return [...remembered, ...live];
}

/** Display projection only: the original invocation remains in the saved prompt/title. */
export function resolveChatDisplayTitle(input: {
  title: string;
  providers: readonly TitleProvider[];
  providerInstanceId: string | null | undefined;
  cwd?: string | null | undefined;
  environmentId?: string | null | undefined;
  literal?: boolean | undefined;
  fallback?: string | undefined;
}): string {
  const source = input.title.trimStart();
  // The editor keeps an unfinished token visible. A list title can recognize
  // an exact, catalog-known skill-only draft without modifying that editor text.
  const body = input.literal ? source : splitAttachedSkills(`${source} `, titleSkills(input)).body;
  return (
    replaceComposerContextReferences(body, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ||
    input.fallback ||
    "New chat"
  );
}

export function resolveComposerDraftTitle(input: {
  fallback?: string | undefined;
  composer: Pick<
    ComposerThreadDraftState,
    | "prompt"
    | "activeProvider"
    | "shellMode"
    | "images"
    | "persistedAttachments"
    | "files"
    | "terminalContexts"
    | "previewAnnotations"
    | "reviewComments"
    | "threadContexts"
  >;
  providers: readonly TitleProvider[];
  cwd?: string | null | undefined;
  environmentId?: string | null | undefined;
}): string {
  const { composer } = input;
  // Rehydrated images mirror persisted attachments; they are not two copies.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length +
    composer.threadContexts.length;
  return resolveChatDisplayTitle({
    title: composer.prompt,
    providers: input.providers,
    providerInstanceId: composer.activeProvider,
    cwd: input.cwd,
    environmentId: input.environmentId,
    literal: composer.shellMode,
    fallback:
      attachmentCount > 0
        ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
        : (input.fallback ?? "New draft"),
  });
}
