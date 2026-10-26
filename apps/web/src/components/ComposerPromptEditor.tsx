import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorHandle } from "./ComposerPromptEditorTiptap";
import { useImperativeHandle, useRef } from "react";
import { WandSparklesIcon, XIcon } from "lucide-react";
import { formatProviderSkillDisplayName } from "@starkfuture/shared/inlineSkills";
import { splitAttachedSkills } from "./composerAttachedSkills";
import { collapseExpandedComposerCursor } from "../composer-logic";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

/**
 * The composer editor. Tiptap in both modes: the `richTextEnabled` setting
 * toggles Markdown styling, never the engine. Plain mode keeps Markdown
 * markers literal; `literalText` also preserves context-token sources as text.
 */
export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  const inner = useRef<ComposerPromptEditorHandle>(null);
  const projection = splitAttachedSkills(props.value, props.literalText ? [] : props.skills);
  const { prefix, body, offset, attached } = projection;
  const collapsedOffset = collapseExpandedComposerCursor(prefix, prefix.length, props.literalText);
  useImperativeHandle(props.editorRef, () => ({
    focus: () => inner.current?.focus(),
    focusAt: (cursor) => inner.current?.focusAt(Math.max(0, cursor - collapsedOffset)),
    focusAtEnd: () => inner.current?.focusAtEnd(),
    isCaretOnVisualEdge: (edge) => inner.current?.isCaretOnVisualEdge(edge) ?? false,
    readSelectionRange: () => {
      const range = inner.current?.readSelectionRange() ?? { start: 0, end: 0 };
      return { start: range.start + offset, end: range.end + offset };
    },
    readSnapshot: () => {
      const snapshot = inner.current?.readSnapshot() ?? {
        value: body,
        cursor: 0,
        expandedCursor: 0,
        contextIds: [],
      };
      return {
        ...snapshot,
        value: prefix + snapshot.value,
        cursor: snapshot.cursor + collapsedOffset,
        expandedCursor: snapshot.expandedCursor + offset,
      };
    },
    requestCitationComment: (request) => {
      const next = splitAttachedSkills(request.value, props.literalText ? [] : props.skills);
      const previous = splitAttachedSkills(
        request.previousValue,
        props.literalText ? [] : props.skills,
      );
      inner.current?.requestCitationComment({
        ...request,
        value: next.body,
        previousValue: previous.body,
        citationStart: Math.max(0, request.citationStart - next.offset),
      });
    },
  }));
  return (
    <div className="min-w-0 flex-1">
      {attached.length ? (
        <div className="composer-attached-skills" aria-label="Attached skills">
          {attached.map(({ skill, start, end }) => (
            <span className="composer-attached-skill" key={`${start}:${skill.name}`}>
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      disabled={props.disabled}
                      className="composer-attached-skill-label"
                      aria-label={`Skill: ${formatProviderSkillDisplayName(skill)}`}
                    />
                  }
                >
                  <WandSparklesIcon aria-hidden />
                  <span>{formatProviderSkillDisplayName(skill)}</span>
                </PopoverTrigger>
                <PopoverPopup width="sm" variant="review" align="start" side="top">
                  <p className="text-sm font-medium">{formatProviderSkillDisplayName(skill)}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {skill.shortDescription ||
                      skill.description ||
                      "Included when you send this message."}
                  </p>
                  {skill.permissionWarning ? (
                    <p className="mt-2 text-xs text-warning">{skill.permissionWarning}</p>
                  ) : null}
                </PopoverPopup>
              </Popover>
              <button
                type="button"
                className="composer-attached-skill-remove"
                aria-label={`Remove ${formatProviderSkillDisplayName(skill)} skill`}
                disabled={props.disabled}
                onClick={() => {
                  const snapshot = inner.current?.readSnapshot();
                  const nextPrefix = prefix.slice(0, start) + prefix.slice(end);
                  props.onChange(
                    nextPrefix + (snapshot?.value ?? body),
                    collapseExpandedComposerCursor(nextPrefix, nextPrefix.length) +
                      (snapshot?.cursor ?? 0),
                    nextPrefix.length + (snapshot?.expandedCursor ?? 0),
                    false,
                    snapshot?.contextIds ?? [],
                  );
                  window.requestAnimationFrame(() => inner.current?.focus());
                }}
              >
                <XIcon aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <ComposerPromptEditorTiptap
        {...props}
        editorRef={inner}
        value={body}
        cursor={Math.max(0, props.cursor - collapsedOffset)}
        onChange={(value, cursor, expanded, adjacent, ids) =>
          props.onChange(prefix + value, cursor + collapsedOffset, expanded + offset, adjacent, ids)
        }
      />
    </div>
  );
}
