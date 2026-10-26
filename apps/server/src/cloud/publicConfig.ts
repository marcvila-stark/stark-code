import { CONNECT_OAUTH_SCOPES } from "@starkfuture/shared/connectAuth";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const cloudUnavailable = () =>
  Config.fail(
    new Schema.SchemaError(
      new SchemaIssue.InvalidValue({
        message: "Hosted cloud services are not included in this application.",
      }),
    ),
  );

export function makeRelayUrlConfig(_fallback = ""): Config.Config<string> {
  return cloudUnavailable();
}

export const relayUrlConfig = makeRelayUrlConfig();
export const hostedAppUrlConfig: Config.Config<string> = cloudUnavailable();

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CONNECT_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig(
  _fallbacks: {
    readonly clerkPublishableKeyFallback?: string;
    readonly clerkCliOAuthClientIdFallback?: string;
  } = {},
): Config.Config<CloudCliOAuthConfig> {
  return cloudUnavailable();
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();
export const hasCloudPublicConfig = false;

export function resolveRelayClientTracingConfig(
  _env: Readonly<Record<string, string | undefined>> = {},
  _fallback = { tracesUrl: "", tracesDataset: "", tracesToken: "" },
): { tracesUrl: string; tracesDataset: string; tracesToken: string } | null {
  return null;
}
