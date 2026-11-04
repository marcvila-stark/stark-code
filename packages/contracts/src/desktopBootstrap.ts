import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  starkHome: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Present when the desktop rotates the renderer's bootstrap token: the
  // backend derives the accepted tokens from this secret instead of trusting
  // `desktopBootstrapToken` for its whole run. See
  // `@starkfuture/shared/desktopBootstrapToken`.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Set only when the desktop already merged the user's shell environment into
  // the environment it hands this backend. Absent means the backend hydrates
  // PATH itself, which WSL and older desktops rely on.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  /** Desktop -> server: the desktop's browser tabs, as newline-delimited JSON. */
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  /** Server -> desktop: commands for those tabs. */
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<starkHome>/runtime` just before the desktop app stops its
    backend to install an update. The updated app starts a new backend right
    away, so a backend that sees a fresh marker at shutdown keeps its managed
    tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";

// Data-protection refusals. Like 78, a supervisor must not restart a server
// that exits with one of these: restarting cannot change the outcome.
/** The database was written by a newer build. Nothing was changed. */
export const SERVER_EXIT_CODE_SCHEMA_NEWER = 79;
/** The database's migration history names migrations this build does not have. */
export const SERVER_EXIT_CODE_SCHEMA_DIVERGENT = 80;
/** The backup before a migration failed, so the migration did not run. */
export const SERVER_EXIT_CODE_BACKUP_FAILED = 81;
/** A migration failed and was rolled back. */
export const SERVER_EXIT_CODE_MIGRATION_FAILED = 82;
/** Another process holds the state for an update, backup or restore. */
export const SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS = 83;

/** Exit codes a backend supervisor treats as terminal (no restart loop). */
export const SERVER_TERMINAL_EXIT_CODES: ReadonlySet<number> = new Set([
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
  SERVER_EXIT_CODE_SCHEMA_NEWER,
  SERVER_EXIT_CODE_SCHEMA_DIVERGENT,
  SERVER_EXIT_CODE_BACKUP_FAILED,
  SERVER_EXIT_CODE_MIGRATION_FAILED,
  SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS,
]);
