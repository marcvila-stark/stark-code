import type { ServerProviderSkill } from "@starkfuture/contracts";
import { resolveProviderSkillSourceKind } from "@starkfuture/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@starkfuture/shared/inlineSkills";
import { useMemo, useRef, useState } from "react";
import { permissionWarningForCatalogEntry } from "../../composerPermissionWarnings";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { searchProviderSkills } from "../../providerSkillSearch";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { plainCatalogText } from "./composerSessionCatalog";
import { composerFloatingLayerProps } from "./composerEventScope";

type ComposerSkillsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerKind: string;
  providerLabel: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  isPending: boolean;
  onSelect: (skill: ServerProviderSkill) => boolean | void;
};

const SOURCE_LABELS = {
  plugin: "Plugin",
  mcp: "MCP",
  repo: "Repository",
  project: "Project",
  personal: "Personal",
  system: "Built-in",
  other: "Provider",
};

export function ComposerSkillsDialog(props: ComposerSkillsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Choose a {props.providerLabel} skill to add to your draft. Nothing is sent until you
            send the message.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <SkillsContent key={`${props.providerKind}:${props.providerLabel}`} {...props} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function SkillsContent(props: ComposerSkillsDialogProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchProviderSkills(props.skills, query), [props.skills, query]);
  return (
    <div className="space-y-4">
      <Input
        type="search"
        aria-label="Search skills"
        placeholder="Search by skill, plugin, or description"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <p className="text-xs text-muted-foreground">
        These are skills {props.providerLabel} reports as available to you, including skills from
        plugins. Plugins with no invocable skills appear in the provider's plugin manager.
      </p>
      {props.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing {props.providerLabel} skills…
        </p>
      ) : null}
      {!props.isPending && results.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {query.trim()
            ? "No matching skills. Try a different name or plugin."
            : `${props.providerLabel} has not reported any available skills for this folder.`}
        </p>
      ) : null}
      <ul className="space-y-3" aria-label={`${props.providerLabel} skills`}>
        {results.slice(0, 100).map((skill) => {
          const warning = permissionWarningForCatalogEntry({ type: "skill", skill });
          const source = SOURCE_LABELS[resolveProviderSkillSourceKind(skill)];
          const name = plainCatalogText(formatProviderSkillDisplayName(skill));
          const description = plainCatalogText(skill.shortDescription ?? skill.description, 1000);
          return (
            <li key={skill.name} className="rounded-xl border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium">{name}</p>
                  <p className="break-words text-xs text-muted-foreground">
                    {source}
                    {skill.pluginName ? ` · ${plainCatalogText(skill.pluginName)}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={`Add ${name} to draft`}
                  disabled={props.isPending}
                  onClick={() => {
                    if (props.isPending) return;
                    if (props.onSelect(skill) !== false) props.onOpenChange(false);
                  }}
                >
                  Add to draft
                </Button>
              </div>
              {description ? <p className="mt-2 break-words text-sm">{description}</p> : null}
              {warning ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {plainCatalogText(warning, 1000)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {results.length > 100 ? (
        <p className="text-xs text-muted-foreground">
          Showing 100 skills. Search to narrow the list.
        </p>
      ) : null}
      <PluginManagementGuide
        providerKind={props.providerKind}
        providerLabel={props.providerLabel}
      />
    </div>
  );
}

function PluginManagementGuide({
  providerKind,
  providerLabel,
}: Pick<ComposerSkillsDialogProps, "providerKind" | "providerLabel">) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copying = useRef(false);
  const command =
    providerKind === "claudeAgent" ? "/plugin" : providerKind === "codex" ? "/plugins" : null;
  const docs =
    providerKind === "claudeAgent"
      ? "https://code.claude.com/docs/en/discover-plugins"
      : providerKind === "codex"
        ? "https://learn.chatgpt.com/docs/developer-commands#browse-plugins-with-plugins"
        : null;
  if (!command || !docs) return null;
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Manage plugins">
      <h3 className="text-sm font-medium">Manage {providerLabel} plugins</h3>
      <p className="text-xs text-muted-foreground">
        Open {providerLabel} in Shell mode in this folder, then paste {command} at an empty prompt
        to browse, install, or manage plugins. Restart the chat's agent after changing plugins.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            if (copying.current) return;
            copying.current = true;
            setError(null);
            setStatus(null);
            void writeTextToClipboard(command, "native plugin command")
              .then(() => setStatus(`Copied ${command}. It has not been run.`))
              .catch(() => setError(`Could not copy. Type ${command} in Shell mode.`))
              .finally(() => {
                copying.current = false;
              });
          }}
        >
          Copy {command}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            setError(null);
            void ensureLocalApi()
              .shell.openExternal(docs)
              .catch(() => setError("Could not open the plugin guide."));
          }}
        >
          Plugin guide
        </Button>
      </div>
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
