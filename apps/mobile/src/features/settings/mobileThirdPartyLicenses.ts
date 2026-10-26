import {
  decodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@starkfuture/shared/thirdPartyLicenses";

let cachedManifest: ThirdPartyLicenseManifest | undefined;

export function getMobileThirdPartyLicenses(): ThirdPartyLicenseManifest {
  if (cachedManifest) return cachedManifest;
  const generatedManifest: unknown = require("@starkfuture/mobile-third-party-licenses");
  cachedManifest = decodeThirdPartyLicenseManifest(generatedManifest);
  return cachedManifest;
}
