import { assert, describe, it } from "@effect/vitest";

import { terminalExitNotice } from "./DesktopTerminalExitNotice.ts";
import { recoveryHoldNotice } from "./DesktopRecoveryStartup.ts";

describe("terminalExitNotice", () => {
  it("explains a failed migration without claiming the data changed", () => {
    const notice = terminalExitNotice({
      exitCode: 82,
      runningVersion: "0.0.46-alpha.2",
      lastRunningVersion: "0.0.46-alpha.1",
    });
    assert.strictEqual(notice?.message, "0.0.46-alpha.2 stopped before changing your data.");
    assert.include(notice?.detail ?? "", "backup from just before is kept");
  });

  it("names the newer version that last used the data", () => {
    const notice = terminalExitNotice({
      exitCode: 79,
      runningVersion: "0.0.46",
      lastRunningVersion: "0.0.47",
    });
    assert.include(notice?.message ?? "", "Stark Code 0.0.47");
    assert.include(notice?.message ?? "", "Nothing was changed.");
  });

  it("leaves other exit codes, 78 included, to their own handling", () => {
    for (const exitCode of [0, 1, 78, 84]) {
      assert.isNull(
        terminalExitNotice({ exitCode, runningVersion: "0.0.46", lastRunningVersion: null }),
      );
    }
  });
});

describe("recoveryHoldNotice", () => {
  it("says where the replaced data is and that background work waits for Resume", () => {
    const notice = recoveryHoldNotice({
      version: 1,
      backupId: "backup-1",
      backupAppVersion: "0.0.46-alpha.1",
      displacedPath: "/tmp/home/backups/backup-1-displaced",
      heldSince: "2026-10-30T00:00:00.000Z",
    });
    assert.strictEqual(
      notice.message,
      "Restored from the 0.0.46-alpha.1 backup; replaced data is in /tmp/home/backups/backup-1-displaced; background work is paused until you resume.",
    );
  });
});
