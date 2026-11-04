# Update rehearsal

Before in-app updates are switched on, a real packaged upgrade must keep a profile's data. This
page is how we prove that locally. Its evidence is labelled **packaged (local mock feed,
development-signed)**. It says nothing about Stark hosting, Developer ID signing or a second Mac;
those are the separate [acceptance gates](./release.md#acceptance-gates).

There are two runs:

- **R1** upgrades a fresh rehearsal profile in this account. An agent or maintainer runs it.
- **R2** upgrades an existing profile in an isolated macOS account. The owner runs it, because only
  a real profile shows that Keychain items, saved environments and preview sessions survive.

## What you need

- A clean checkout of the commit under test, with dependencies installed.
- An Apple Development certificate. Read its SHA-1 outside the sandbox with
  `security find-identity -v -p codesigning`. N and N+1 must carry the same certificate, or the
  updater refuses N+1. Ad-hoc builds can never update.
- `scripts/build-desktop-artifact.ts` bakes `STARK_CODE_DESKTOP_UPDATE_FEED=mock`,
  `STARK_CODE_DESKTOP_REHEARSAL_PROFILE` and `STARK_CODE_DESKTOP_REHEARSAL_FAULT` into the app's
  `starkcodeUpdate` policy (mock builds only); `verify` refuses a build without them. The app then
  uses `<profile>/home` as its Stark home and `<profile>/app-data` as its desktop data directory on
  every launch, whatever its environment says.
- `DESKTOP_AUTO_UPDATE_ACTIVATED` (`apps/desktop/src/app/DesktopConfig.ts`) only governs Stark
  feeds, so the mock builds update while it is still `false`.
- Disk space: each build is about 1.5 GB plus its extracted app. A build's temporary stage (about
  600 MB) is removed when the build ends, including after a crash.

## Isolation

- The profile lives in `~/.stark-code-update-rehearsal/<run id>/profile` and is baked into both
  builds. The updater relaunches the app without its environment, so only a baked profile keeps
  N+1 on rehearsal data. The script refuses any root that overlaps `~/.stark-code`,
  `~/Library/Application Support` or the repository.
- electron-updater keeps a rehearsal build's downloads in `<profile>/caches/starkcode-updater`.
  Squirrel.Mac's caches cannot be moved from inside the app. It keeps them by bundle ID in
  `~/Library/Caches/com.starkfuture.starkcode` and `~/Library/Caches/com.starkfuture.starkcode.ShipIt`,
  the same folders a real install uses. Do not run a rehearsal while an update of a real install is
  pending, and remove both folders afterwards if no real install uses them.
- `guard before` and `guard after` stat the live install and list the processes holding its files.
  The guard fails if a rehearsal process ever held a live file. Changes made by your own running
  app are reported, not failed. `guard-verdict.json` and the step's output name every process that
  held a live file at either check, with its command line and the raw `lsof` output, so a change can
  be traced to its opener. A file opened and closed between the checks has no holder to name.
- Quit apps and the feed server only by the PID you started.

## R1: rehearsal profile

Print the run, then execute its commands in order with the same run id:

```sh
node scripts/update-rehearsal.ts plan --run-id <id> --identity <certificate SHA-1>
```

The plan covers these phases:

1. **Builds.** N (`0.0.46-alpha.1`) comes from the commit under test. N+1 (`0.0.46-alpha.2`)
   comes from a never-pushed scratch commit that labels Settings → About "Version (update rehearsal
   N+1)". A third build adds the migration fault. `cleanup-n1` removes the scratch branch; run it
   even when a build fails. `verify` checks each proof, the packaged `app-update.yml`, the baked
   policy and the signature. It also checks that N+1 satisfies N's designated requirement, which is
   what the updater checks at install.
2. **Feeds.** `feed` writes `release-mock/rehearsal-<id>/feeds/` with `feed`, `feed-corrupt` (one
   byte flipped), `feed-older` (offers 0.0.45) and `feed-fault-migration`. The mock server serves
   one of them and runs a canary on the next port that stands in for every forbidden host.
3. **Fixture.** Install and launch N, create the fixture through the UI (chats tagged
   `UPD-<id>-T1…T4`, a pasted image, drafts, stash, settings, projects, providers, permission modes,
   scheduled tasks, a pending approval that is declined, never approved), save renderer storage,
   quit, and capture `inventory-before`.
4. **Upgrade.** Check for updates, download, choose Restart to update. Swapping the bundle or a hot
   reload does not count.
5. **Check.** The installed bundle reports N+1. Open the chats and the attachment, restore the draft,
   check settings, providers and modes, then capture `inventory-after`. `compare` must say `pass`.
   Restart once more and compare again: no task or approval may run twice.
6. **Close.** `guard after`, then `record`.

### Failure rows

`plan` ends with every failure row the mock feed can drive: its feed root, its fault plan and the
expected result. Start each row from a fresh copy of the N profile (copy `profile/` after the
fixture and restore it between rows). The feed rereads `evidence/faults.json` on every request, so
a row only edits that file:

```json
{ "faults": [{ "path": "*.zip", "mode": "truncate-once" }] }
```

A different feed root needs a server restart. Not covered yet: a wrong signing identity (needs a
throwaway self-signed identity, owner switch S6), and the `backup-enospc` and `commit-stall` faults
(no build bakes them yet).

Row 11 serves `feed-fault-migration`. That N+1 carries the `migration-fail` fault: its server
takes the pre-migrate backup, fails one migration step once, and the app explains the outcome and
quits. Reinstall N from its DMG, quit it, restore the `pre-install` backup N took
(`stark-code backup list`, then `stark-code backup restore <id>` with `STARK_CODE_HOME` set to the
profile's `home`), and launch N twice: both boots must offer **Resume**, and nothing scheduled may
run until you choose it (or run `stark-code backup resume` with the app closed).

### Evidence

- `evidence/run-record.json` binds the commits, artifact hashes, designated requirements and Team
  IDs, the guard verdict, both compare verdicts and the hash of every evidence file.
- `evidence/mock-requests.jsonl` logs every feed and canary request with redacted credentials. A
  hostile-manifest or redirect row passes only with 0 canary hits and the app's own boundary log
  showing the block. The mock log alone cannot show requests sent elsewhere, so also capture
  `lsof -i -n -P -p <pid>` during check, download and install.
- Screenshots of About before and after, the chats, the draft and settings. Keep credentials and
  private content out of them.

## R2: existing profile

1. The owner creates or provides a disposable macOS account (owner switch S7).
2. In the developer's account, print the R2 plan and run its build, verify, feed, share and
   serve steps. These builds bake no profile.

   ```sh
   node scripts/update-rehearsal.ts plan --profile existing --account-home /Users/<isolated account> \
     --run-id <id> --identity <certificate SHA-1>
   ```

3. In the isolated account, follow the printed owner steps. The inventory runs from the standalone
   copy of `release-inventory.ts` in `/Users/Shared/stark-update-rehearsal`. R2a installs the
   current alpha, adds real data, upgrades to N by DMG and then to N+1 in the app. R2b repeats this
   with N launched from Terminal with a custom `STARK_CODE_HOME` and `STARK_CODE_DESKTOP_DATA_DIR`.

The owner must observe:

- About shows N+1 and the marker.
- No Keychain password prompt. A prompt means the app's identity changed: stop and report it.
- The saved environment connects without signing in, and the imported preview session is still
  signed in.
- Provider homes are unchanged, and R2b still uses its custom paths after the updater's relaunch.
- Chats, draft and attachment survive a second restart.
- The pending approval is declined, never approved.

Afterwards the owner decides what happens to leftover Keychain items and the account.

## Cleanup

Delete `release-mock/rehearsal-<id>` and `~/.stark-code-update-rehearsal/<id>` once the evidence is
archived. Report Keychain items the rehearsal created instead of deleting them.
