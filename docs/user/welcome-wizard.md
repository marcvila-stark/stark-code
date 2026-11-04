# Welcome wizard

Stark Code shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Connect your computers

Select one or more computers to set up. If you opened Stark Code directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **Stark Connect** connects computers that are signed in to your account.
  [Install the CLI](./install.md#command-line) and run `stark-code connect` on each
  computer you want to add, then start Stark Code or run `stark-code serve` so the
  computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `stark-code serve`, then run `stark-code pair --tailscale` and paste
  the pairing link. You can also run `stark-code serve --host <address>` and use
  `stark-code pair` when the server is already reachable on your network.

Saved computers and computers discovered through Stark Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then asks for your main working folder.

If Stark Code cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If Stark Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

Stark Code checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Open your main folder

Choose your main working folder to open it as one workspace. You can open a Git
repository or a parent folder containing several repositories. On the local Mac
app, use the folder picker. On a remote connection or in a browser, enter the
folder's full path on that computer.

Setup opens only the folder you chose. It does not create separate projects from
old conversation folders or import their history. Existing projects and
conversations remain available. Opening a folder already in Stark Code reuses it.
To bring in Claude Code or Codex sessions later, see
[Import Claude Code and Codex sessions](./thread-sidebar.md#import-claude-code-and-codex-sessions).

For the integrated Git worktree controls, open the repository's main checkout.
Choose **Choose later** to finish setup without opening a folder. You can return
to an earlier step using the setup progress bar; navigation pauses while a folder
is opening.
