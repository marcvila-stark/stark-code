import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  desktopDataDirectory: trimmedString("STARK_CODE_DESKTOP_DATA_DIR"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  starkHome: trimmedString("STARK_CODE_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("STARK_CODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteStarkServerEntryPath: trimmedString("STARK_CODE_DEV_REMOTE_STARK_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.Port("STARK_CODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("STARK_CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("STARK_CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("STARK_CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: Config.succeed(Option.none<string>()),
  otlpMetricsUrl: Config.succeed(Option.none<string>()),
  otlpLogsUrl: Config.succeed(Option.none<string>()),
  otlpExportIntervalMs: Config.succeed(10_000),
  otlpHeaders: Config.succeed(Option.none<Record<string, string>>()),
  otlpProtocol: Config.succeed("http/json" as const),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: Config.succeed(true),
  mockUpdates: Config.succeed(false),
  mockUpdateServerPort: Config.Port("STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
