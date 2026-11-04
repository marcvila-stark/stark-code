# Local builds and releases

Stark Code alpha installers are distributed manually through the [Stark Pages download page](https://pages.starkfuture.com/stark-code/index.html). This checkout has no configured production release feed or automatic publishing workflow.
The install scripts intentionally exit with a local-build message. Do not use an npm
package, app-store listing, or download URL as the distribution source for this fork
unless a maintainer has explicitly configured and verified it.

## Start the app

Use Node.js 24 and follow [Run from source](../../README.md#run-from-source).
`Start Stark Code.command` keeps development state inside the checkout's `.stark-code`
directory, separate from the installed app's data.

## Package a local desktop build

From the repository root, after installing the pinned dependencies:

```sh
npm run dist:desktop:dmg:arm64
```

For an Intel Mac, use `npm run dist:desktop:dmg:x64`. Other packaging targets are listed
in the root `package.json`. Builds are written to `release/`. A build is unsigned unless
`--signed` is passed; macOS signing is described in
[Signed macOS builds](#signed-macos-builds). Building an artifact does not publish it.
An unsigned build may require local operating-system approval before opening.

Before distributing a build, test the packaged app with a separate data directory,
verify its version and bundled provider/plugin behavior, and confirm that it contains no
unconfigured service or download links. Provide the verified artifact directly through
the team's chosen distribution channel.

## Signed macOS builds

A macOS build runs in one of three modes, and `--signed` selects one of the two signed ones.
A signed build checks the credentials before it compiles anything, stops with the names of
missing or conflicting variables (never their values), and verifies the packaged app
afterwards.

| Mode                   | Select with                                                | Signed with                            | Notarized                 | Checked after packaging                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unsigned rehearsal     | no `--signed`                                              | nothing                                | no                        | nothing; signing variables are removed from the packaging environment                                                                                              |
| Development            | `--signed` and `STARK_CODE_MACOS_SIGNING_MODE=development` | an Apple Development certificate       | never                     | a valid signature from the selected certificate, with hardened runtime                                                                                             |
| Developer ID (default) | `--signed`                                                 | a Developer ID Application certificate | app and DMG, both stapled | the development checks, plus a secure timestamp, `APPLE_TEAM_ID` if set, stapled tickets, and Gatekeeper accepting the app and the DMG as `Notarized Developer ID` |

A development build only proves that two local builds signed with the same certificate can
replace each other. It is never accepted on another Mac and never has to pass Gatekeeper.

### Apple requirements

- Apple Developer Program membership for the organization. Only the Account Holder can
  create the **Developer ID Application** certificate. Keep it in the build Mac's login
  keychain, or export it with its private key as a `.p12`.
- One notarization credential: an App Store Connect API key with the Developer role, an
  Apple ID with an app-specific password, or a `notarytool` keychain profile created with
  `xcrun notarytool store-credentials`.
- A Mac with the Xcode Command Line Tools (`codesign`, `notarytool`, `stapler`) and outbound
  access to Apple's notary service.

### Environment variables

Set exactly one signing identity and, for Developer ID, exactly one notarization set.

| Variable                                                   | Use                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STARK_CODE_MACOS_SIGNING_MODE`                            | `developer-id` (default with `--signed`) or `development`. Rejected without `--signed`.                                                          |
| `CSC_LINK` and `CSC_KEY_PASSWORD`                          | Identity: path to the `.p12` (or its base64) and its password.                                                                                   |
| `CSC_NAME`                                                 | Identity: a login keychain certificate, by name without the `Developer ID Application:` prefix, or by SHA-1. Use the SHA-1 for development mode. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`    | Notarization: path to `AuthKey_<key id>.p8`, the key ID and the issuer ID.                                                                       |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization with an Apple ID.                                                                                                                   |
| `APPLE_KEYCHAIN_PROFILE`, optional `APPLE_KEYCHAIN`        | Notarization with a stored `notarytool` profile.                                                                                                 |
| `APPLE_TEAM_ID`                                            | With any Developer ID set: the team the signature must carry.                                                                                    |
| `STARK_CODE_MACOS_PROVISIONING_PROFILE`                    | Optional. Opts into passkey entitlements; see [Desktop passkeys](./connect-setup.md#desktop-passkeys).                                           |

Keep credentials in the shell session or the login keychain. Never put them in `.env` or
`.env.local`: worktree setup links those files into every worktree.

When `CSC_NAME` is used, the build asks the login keychain which certificate
electron-builder will pick and stops if it is the wrong kind. electron-builder's search
prefers a Developer ID certificate for any name the two certificates share, so a
development build needs the Apple Development certificate's SHA-1 from
`security find-identity -v -p codesigning`.

```sh
# Developer ID: signed, notarized and stapled.
export CSC_NAME="Stark Future GmbH (TEAMID1234)"
export APPLE_KEYCHAIN_PROFILE=stark-notary
export APPLE_TEAM_ID=TEAMID1234
npm run dist:desktop:dmg:arm64 -- --signed --build-version 0.0.46-beta.1

# Development rehearsal: signed with an Apple Development certificate, never notarized.
STARK_CODE_MACOS_SIGNING_MODE=development CSC_NAME=<40-character SHA-1> \
  npm run dist:desktop:dmg:arm64 -- --signed
```

The DMG is notarized and stapled after electron-builder writes it. Stapling changes the
file, so the build then rebuilds the DMG's `.blockmap` and its digest in `latest-mac.yml`.

### Release proof

Every macOS build writes `release-proof.json` beside its artifacts, last, from the final
files. It records the version, channel, commit, the update feed baked into the app, the
size and SHA-256 of each artifact, and the signing result: mode, certificate, team,
hardened runtime, timestamp, which credential set notarized it, stapling, and Gatekeeper's
verdict. `distributable` is true only for a notarized Developer ID build of the
`appleTeamId` team whose designated requirement pins that team, on a Stark feed or
without one. The proof holds no credential values.

### Update feeds

Who may serve updates is checked in. `stark.brand.json` names the Apple team every
updating build is signed by (`appleTeamId`), the HTTPS origins that may host a feed
(`updateFeedOrigins`) and the channels a feed serves (`updateChannels`, `latest` only).
The build and the packaged app apply the same rules
(`scripts/lib/update-feed-ownership.ts`).

| Variable                                              | Use                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `STARK_CODE_DESKTOP_UPDATE_FEED`                      | `none`, `stark` or `mock`. Required with `--signed`; an unsigned build defaults to `none`. Any other value stops the build. |
| `STARK_CODE_DESKTOP_UPDATE_URL`                       | With `stark` only: the feed directory, `https://<origin>/<path>/`. The origin must be in `updateFeedOrigins`.               |
| `--mock-updates` or `STARK_CODE_DESKTOP_MOCK_UPDATES` | The same as `mock`: bakes `http://localhost:<port>/` for `scripts/mock-update-server.ts` and writes to `release-mock/`.     |
| `STARK_CODE_DESKTOP_UPDATE_REPOSITORY`                | Removed. Any value stops the build.                                                                                         |
| `STARK_CODE_DESKTOP_REHEARSAL_PROFILE`, `_FAULT`      | With `mock` only, for the [update rehearsal](./update-rehearsal.md): the profile (absolute) and fault (`migration-fail`).   |

- A build without a feed writes `publish: null`, and the packaging environment drops
  `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `KEYGEN_TOKEN`, `BITBUCKET_TOKEN`,
  `TRAVIS_REPO_SLUG`, `APPVEYOR_REPO_NAME` and `CIRCLE_PROJECT_*`, so electron-builder
  cannot derive a feed from tokens, CI variables or a `repository` field. Preview and
  pull request versions never carry a feed.
- A `stark` feed needs a Developer ID build, `APPLE_TEAM_ID` equal to `appleTeamId`,
  and a version on an enabled channel (nightly versions are refused). The signed app's
  designated requirement must pin the bundle id and that team.
- A `mock` feed is refused for Developer ID builds and outside `release-mock/`. It is
  for development-signed rehearsals. Its channel manifests carry `starkFeedKind: mock`:
  the mock server serves nothing else, a mock app follows nothing else, and a Stark
  app and the release publisher refuse them.
- After packaging, the build checks every `app-update.yml` with the app's own
  validator and stops on any difference, including a file in a build that should
  have none. `release-proof.json` records the feed, the baked policy, the packaged
  `app-update.yml` with its SHA-256, and the designated requirement.

`updateFeedOrigins` stays empty until hosting is approved, so every `stark` build stops
today. Adding the approved origin, after confirming that `appleTeamId` is the team
holding the Developer ID certificate, is what enables them.

The packaged app follows a feed only when its `app-update.yml`, the policy baked into
its `package.json` (`starkcodeUpdate`) and `stark.brand.json` agree, and its own
signature is from that team (never unsigned or ad hoc). Every request, redirects
included, must stay on the feed's origin and below its directory; Squirrel.Mac only
receives electron-updater's `127.0.0.1` hand-off of the ZIP it already downloaded.
Updates never downgrade and never use differential downloads.
`STARK_CODE_DISABLE_AUTO_UPDATE` can only switch updates off; no environment variable
adds or changes a feed.

Before offering a download for a restart, and again before the restart, the app
extracts the downloaded ZIP and requires the pinned Stark requirement (Apple anchor,
bundle id, `appleTeamId`), its own designated requirement, the offered version and its
own baked policy; a rejected download is deleted.

In-app updates from a Stark feed are inactive for now: `DESKTOP_AUTO_UPDATE_ACTIVATED`
in `apps/desktop/src/app/DesktopConfig.ts` stays `false` (an owner switch) until the
packaged rehearsals pass, and About says updates aren't switched on yet. Mock feed
builds, which never leave `release-mock/`, update regardless so the rehearsals can run.
Builds published before update ownership existed carry no feed and never update; replace
them by installing a newer DMG. Hosted clients and relay or sign-in services are separate
deployments and stay disabled in the app. No fallback public domain is assumed.

## Acceptance gates

A beta is ready for other Macs only after all three gates pass, in order. Each needs its own
evidence; passing one says nothing about the next.

1. **Build tooling ready.** Verifiable in this repository without credentials: the signing
   plan, mode-specific verification, DMG finalization order and feed selection tests in
   `scripts/build-desktop-artifact.test.ts` pass, including the one that runs the installed
   electron-builder's own identity search against the build's prediction, and `--signed`
   without complete credentials stops before staging with the missing variable names.
2. **Signed artifact verified.** A Developer ID build completes and its
   `release-proof.json` shows `distributable: true`. Confirm independently on the build Mac:

   ```sh
   codesign --verify --deep --strict --verbose=2 "Stark Code (Alpha).app"
   spctl --assess --type execute --verbose=2 "Stark Code (Alpha).app"   # source=Notarized Developer ID
   xcrun stapler validate Stark-Code-<version>-arm64.dmg
   spctl --assess --type open --context context:primary-signature --verbose=2 Stark-Code-<version>-arm64.dmg
   ```

   Blocked until the organization's Developer ID Application certificate and a notarization
   credential exist.

3. **Installed and updated on a teammate's Mac.** On a second Apple silicon Mac, with the
   existing data backed up (`ditto ~/.stark-code/userdata ~/stark-code-backup-<version>`):
   the DMG, downloaded in a browser so it is quarantined, opens without "Open Anyway";
   Keychain asks at most once after the signing identity changes; existing threads, drafts
   and settings are intact; and a later build replaces it with the data still intact.
   Record any Gatekeeper or endpoint-management block instead of disabling protections.
   Blocked on the signed artifact from gate 2 and a second Mac. The update half is also
   blocked while the packaged app keeps in-app updates off and no feed is hosted; until
   then, install the next DMG over the previous one.

## Release checklist

The steps for publishing the next update once in-app updates are enabled. Run them in order;
each gate needs its own evidence.

1. **Hosting and signing are decided** (owner, DevOps). The feed's HTTPS origin is in
   `stark.brand.json` `updateFeedOrigins` and the team is `appleTeamId`. Until both exist, every
   Stark-feed build and every publish refuses.
2. **The commit passed its tests and the [update rehearsal](./update-rehearsal.md)** (maintainer,
   owner). R1 `compare` said `pass` twice and the live-install guard did not fail. R2 has passed
   or is with the owner.
3. **Pick the version** (maintainer): newer than the feed's current one, ending in `-alpha.N`,
   `-beta.N` or nothing. `-preview.` and `-pr.` versions get no feed.
4. **Build each architecture** (maintainer, on the publishing Mac) with the Stark feed and
   Developer ID signing, each into its own directory such as `release/arm64` and `release/x64`.
   Each `release-proof.json` must say `distributable: true`.
5. **Check the signed artifacts by hand** (maintainer) with the commands in
   [gate 2](#acceptance-gates).
6. **Dry run** (maintainer):

   ```sh
   node scripts/publish-update-feed.ts --build release/arm64 --build release/x64 \
     --feed-url <feed URL> --target s3://<bucket>/<prefix>/
   ```

   Every check must pass: the approved origin, the proofs and team, no mock or rehearsal policy,
   artifact hashes, the manifest's digests and file names, both architectures, and `codesign` of
   the app inside each update ZIP. Keep `publish-record.json`.

7. **Publish** (maintainer): repeat with `--execute`, using the existing upload credentials. It
   takes the feed's lock, uploads the immutable artifacts, reads them back and replaces
   `latest-mac.yml` last. A refusal leaves the manifest unchanged.
8. **Check from outside** (maintainer, a teammate): fetch `<feed URL>latest-mac.yml` and the files
   it names, compare their hashes with the record, and see the previous version offer the update.
   Then run [gate 3](#acceptance-gates) on a second Mac.

A bad release is fixed by publishing a newer version. Never put an older `latest-mac.yml` back:
clients that already updated would be offered nothing, and the app refuses downgrades.
