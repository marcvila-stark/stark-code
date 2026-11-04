import { describe, expect, it } from "vite-plus/test";

import {
  enabledDesktopUpdateChannels,
  isDesktopUpdateChannelEnabled,
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  it("offers only the channels stark.brand.json enables, which is latest today", () => {
    expect(enabledDesktopUpdateChannels()).toEqual(["latest"]);
    expect(isDesktopUpdateChannelEnabled("latest")).toBe(true);
    expect(isDesktopUpdateChannelEnabled("nightly")).toBe(false);
    // Unknown entries are ignored rather than widening the contract.
    expect(enabledDesktopUpdateChannels(["latest", "beta", "nightly"])).toEqual([
      "latest",
      "nightly",
    ]);
  });
});
