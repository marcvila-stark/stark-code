# Stark Code

Stark Future’s Mac coding workspace. Run Codex and Claude with graphical conversations, native agent shells, terminals, diff review, and Git worktrees for parallel tasks.

## Install on Mac

[Download Stark Code for Apple silicon Macs from Stark Pages](https://pages.starkfuture.com/stark-code/index.html).

Open the DMG and drag **Stark Code (Alpha)** to **Applications**. The download page uses Stark's access settings and may require your work sign-in. This is an alpha preview; its current signing and installation requirements are listed with the download.

Run agents with your own installed Codex or Claude CLI and subscription. New graphical chats ask for action approvals by default. Chrome Capture can add selected text, images, and region screenshots—with their source URL—to a new or existing chat draft. You review the draft before sending. See [Chrome Capture setup](apps/chrome-extension/README.md).

Updates are installed manually from the download page while the production signing and update feed are being configured.

## Run from source

Use Node.js 24 and the pinned package manager:

```sh
nvm use 24
npx --yes --package=pnpm@11.10.0 pnpm install --frozen-lockfile
npm run dev:desktop -- --home-dir "$PWD/.stark-code"
```

You can also double-click **Start Stark Code.command** after installing dependencies. Development data and the Electron profile stay in the checkout. Hosted sign-in and relay services are disabled in this fork.

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
