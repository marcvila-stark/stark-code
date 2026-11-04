import type { EnvironmentId } from "@starkfuture/contracts";
import { ContextChipLabel } from "../ContextChip";

/** Label for a file mention; render inside `<ContextChip kind="mention">`.
 * No file-type icon: a glyph inside running text pulls the eye away from the
 * sentence, and the path already says what the file is. Trees and pickers
 * keep their icons. */
export function FileTagChipContent(props: {
  path: string;
  label: string;
  theme: "light" | "dark";
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
}) {
  return <ContextChipLabel>{props.label}</ContextChipLabel>;
}
