import { relayClerkTokenOptions } from "@starkfuture/shared/relayAuth";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("STARK_CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

export function resolveCloudPublicConfig(_extra: ExpoExtra = undefined): CloudPublicConfig {
  return {
    clerk: { publishableKey: null, jwtTemplate: null },
    relay: { url: null },
    observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  };
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerk.publishableKey && config.clerk.jwtTemplate && config.relay.url);
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  _config: CloudPublicConfig = resolveCloudPublicConfig(),
): _config is TracingPublicConfig {
  return false;
}

export function resolveRelayClerkTokenOptions() {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "STARK_CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}
