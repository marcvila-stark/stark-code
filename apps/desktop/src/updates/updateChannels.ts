import { DesktopUpdateChannelSchema, type DesktopUpdateChannel } from "@starkfuture/contracts";
import { BRAND } from "@starkfuture/shared/branding";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They share nightly's branding but
// are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

const isDesktopUpdateChannel = Schema.is(DesktopUpdateChannelSchema);

/**
 * Owner switch: the channels a Stark feed serves (`updateChannels` in
 * stark.brand.json). Only `latest` today; a channel missing here is never
 * offered, and the build refuses to bake a feed for it.
 */
export function enabledDesktopUpdateChannels(
  configured: ReadonlyArray<string> = BRAND.updateChannels,
): ReadonlyArray<DesktopUpdateChannel> {
  return configured.filter(isDesktopUpdateChannel);
}

/**
 * The channels the updater offers and follows, `enabledDesktopUpdateChannels()`
 * unless a test supplies its own. Nightly stays hidden while it is not one.
 */
export class DesktopEnabledUpdateChannels extends Context.Reference<
  ReadonlyArray<DesktopUpdateChannel>
>("@starkfuture/desktop/updates/updateChannels/DesktopEnabledUpdateChannels", {
  defaultValue: () => enabledDesktopUpdateChannels(),
}) {}

export function isDesktopUpdateChannelEnabled(
  channel: DesktopUpdateChannel,
  configured: ReadonlyArray<string> = BRAND.updateChannels,
): boolean {
  return enabledDesktopUpdateChannels(configured).includes(channel);
}

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
