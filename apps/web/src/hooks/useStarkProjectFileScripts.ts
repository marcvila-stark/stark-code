import {
  STARK_PROJECT_FILE_NAME,
  type EnvironmentId,
  type StarkProjectFile,
  type StarkProjectFileScript,
} from "@starkfuture/contracts";
import { parseStarkProjectFile } from "@starkfuture/shared/starkProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<StarkProjectFileScript> = [];

export interface StarkProjectFileState {
  /**
   * - `valid`: stark.json exists and decoded.
   * - `invalid`: stark.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable stark.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: StarkProjectFile | null;
  scripts: ReadonlyArray<StarkProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `stark.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useStarkProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): StarkProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    STARK_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseStarkProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `stark.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useStarkProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<StarkProjectFileScript> {
  return useStarkProjectFileState(environmentId, cwd).scripts;
}
