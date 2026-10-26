# Private Alpha builds and releases

The private source repository and download location are [starkfuture/stark-code](https://github.com/starkfuture/stark-code). Desktop installers are attached to prereleases in [GitHub Releases](https://github.com/starkfuture/stark-code/releases). Repository access is required to download them. Do not expose a token in a download URL.

The initial distribution targets Apple silicon and macOS 13.3+. It preserves the tested development signature; it is not Developer ID signed or notarized. It does not use the App Store. Automatic updates remain disabled; testers install each update manually. Do not describe the initial installer as production ready or as verified on Intel Macs.

## Build

Use Node.js 24, install the pinned dependencies, then run from the repository root:

```sh
npm run dist:desktop:dmg:arm64
```

Other packaging targets remain in package.json. Building an artifact does not publish it. An Intel artifact needs its own build and verification before distribution.

## Verify and publish

Use a separate Stark home and desktop data directory to test first launch and restart. Never use the developer's live database. Check the packaged provider/plugin behavior, app signature, minimum system version, and disk image integrity. Confirm that no credentials, imported browser sessions, development paths, or unconfigured service links are bundled.

Attach the verified DMG and its SHA-256 checksum to a private GitHub prerelease. Include architecture, macOS minimum, installation steps, known limitations, and the source revision. Verify the uploaded asset's size and checksum before giving the team a link.

## Automation

GitHub Actions is disabled initially. Inherited CI workflows require Blacksmith runners and must be adapted or provisioned before enabling them. No release feed, public installer endpoint, or automatic release workflow is configured. Hosted clients and relay/sign-in services are separate deployments and remain disabled in this fork.
