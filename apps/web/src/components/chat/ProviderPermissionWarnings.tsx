import type { ComposerPermissionWarning } from "../../composerPermissionWarnings";
export function ProviderPermissionWarnings({
  warnings,
}: {
  warnings: ReadonlyArray<ComposerPermissionWarning>;
}) {
  return warnings.length ? (
    <details data-provider-permission-warning className="text-xs text-muted-foreground">
      <summary className="cursor-pointer text-warning">Skill permissions may differ</summary>
      <div className="mt-2 space-y-1">
        {warnings.map((entry) => (
          <p key={entry.reference}>
            <code>{entry.reference}</code> {entry.warning}
          </p>
        ))}
      </div>
    </details>
  ) : null;
}
