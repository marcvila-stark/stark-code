/** Disable optional CLI reporting without changing provider authentication or task traffic. */
export const PROVIDER_PRIVACY_ENV = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  OTEL_SDK_DISABLED: "true",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
} as const;

/** CLI overrides are applied last so personal profiles cannot enable optional reporting. */
export const CODEX_PRIVACY_CONFIG = {
  "analytics.enabled": false,
  "otel.exporter": "none",
  "otel.trace_exporter": "none",
  "otel.metrics_exporter": "none",
  "otel.log_user_prompt": false,
} as const;

export const CODEX_PRIVACY_ARGS: ReadonlyArray<string> = Object.entries(
  CODEX_PRIVACY_CONFIG,
).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
