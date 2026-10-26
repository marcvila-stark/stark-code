# Stark Code

Stark Future’s Mac coding workspace. Run Codex and Claude with graphical conversations, native agent shells, terminals, diff review, and Git worktrees for parallel tasks.

## Install the private Alpha

Packaged Mac builds are shared through [GitHub Releases](https://github.com/starkfuture/stark-code/releases). Sign in to GitHub with an account that has access to this private repository.

The first build targets **Apple silicon (M1 or newer), macOS 13.3 or newer**. Download the DMG, open it, and drag **Stark Code (Alpha)** into **Applications**. You do not need the source code, Node.js, or npm to use the packaged app.

This internal Alpha is not distributed through the App Store and is not Apple-notarized. If macOS blocks it, use the app-specific **Open Anyway** option in **System Settings → Privacy & Security**, where company device policy allows it. See [Apple's instructions](https://support.apple.com/en-us/102445). Automatic updates are not configured; install new builds from Releases.

On first launch, connect Claude or Codex and choose a folder. Existing supported agent installations and sign-ins may be detected. Each tester uses their own provider account. Browser sign-in import is optional.

The app is an Alpha for a small internal pilot. Report problems with the app version and what you were trying to do; do not attach tokens, cookies, credentials, or private conversation exports.

## Start from source

Use Node 24. Dependencies are installed in this checkout. Double-click **Start Stark Code.command**, or run:

```sh
nvm use 24
npm run dev:desktop -- --home-dir "$PWD/.stark-code"
```

The launcher keeps development data and the Electron profile inside the checkout. The app does not send telemetry and hosted relay services are disabled. New agents require approvals by default. The app is built and updated locally.

For a fresh checkout, install the pinned dependencies before starting:

```sh
npx --yes --package=pnpm@11.10.0 pnpm install --frozen-lockfile
```

## Native shell mode

Open or create a thread, choose Claude or Codex, then select **Shell mode** in the header. The same action is available in the command palette and with **⌘⌥J** on Mac (**Ctrl+Alt+J** elsewhere).

On a new thread, Stark prepares the selected workspace or Git worktree without sending a model prompt. The native mode starts the selected provider’s installed interactive CLI in that thread’s workspace or Git worktree, using its configured executable, launch arguments, and account environment. Slash commands, plugins, skills, MCP configuration, and permission prompts are handled by the CLI itself.

Shell and graphical chat share project files, but have separate conversation histories. Changing views or threads leaves the shell process running; use the CLI’s exit command to end it. Returning to shell mode reattaches to that process. Graphical sending waits while the thread’s native agent is running. Use separate threads and worktrees for parallel edits.

Native shell mode is advertised by the Stark server. Older remote servers need an update before their clients can use it.

## Project layout

- `apps/desktop`: Electron Mac app and platform integration.
- `apps/web`: workspace interface and native terminal renderer.
- `apps/server`: provider processes, durable sessions, Git, and PTY management.
- `packages/contracts`: shared API and event schemas.
- `packages/client-runtime`: shared client state and commands.

`stark.brand.json` holds the application identity. The application identifier is `com.starkfuture.starkcode`.

## Licenses

The required source copyright and third-party license notices are included in `LICENSE` and the in-app open source licenses screen.
