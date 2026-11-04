# Remote access

Connect a phone, browser, or another desktop app to Stark Code running on a different
machine. That machine must stay running and reachable while you work.

## Use Stark Code from your phone or another computer

The supported way to reach a machine from elsewhere is **Tailscale HTTPS direct
pairing**. Tailscale gives the host a private HTTPS address on your tailnet, such as
`https://machine.tailnet.ts.net/`, and forwards it to Stark Code on the host's
loopback address. The host needs no open ports or LAN access, nothing runs on
Stark-hosted servers, and the address works from any network your devices reach the
tailnet from.

### What you need

- Tailscale installed and signed in on the host and on every device you connect
  from, all in the same tailnet.
- MagicDNS and HTTPS certificates turned on for the tailnet in the Tailscale admin
  console.
- The host stays on and keeps Stark Code running. On a server without a desktop,
  use the [background service](./background-service.md).

### Set up the host

In the desktop app on the host, open **Settings → Connections**, find **Tailscale
HTTPS**, and choose **Setup** (or turn on its switch). Keep the HTTPS port unless
something else on the tailnet already uses it, then confirm. Stark Code restarts
its local server with Tailscale Serve and shows the HTTPS address. Turn it off in
the same place, or choose **Disable**, to remove that address.

Then create a pairing link in **Settings → Connections** and choose the Tailscale
HTTPS address for it. The link looks like `https://machine.tailnet.ts.net/pair#…`.

On a command-line host, start the server with Tailscale HTTPS:

```bash
stark-code serve --tailscale-serve
```

For a server that is already running, publish it and print a fresh pairing link
and QR code:

```bash
stark-code pair --tailscale
```

The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with `--tailscale-serve-port`. See
`stark-code pair --help` for other pairing options.

### Open it on the other device

- **Phone or tablet browser.** With Tailscale connected on the phone, open the
  pairing link in Safari or Chrome. The host serves the full Stark Code web app,
  so nothing else needs installing. Add it to your Home Screen to open it like an
  app.
- **Desktop app on another computer.** Open **Settings → Connections → Add
  environment** and paste the pairing link.
- **Stark Code mobile app**, where it is installed. Open **Settings →
  Environments**, tap **+** (Add environment), and scan the QR code or paste the
  link.

Use a fresh one-time link for each device. Pairing authorizes that device for
future connections; it reconnects without the link.

### Check the host before you rely on it

Run through this once for each host, and again after installing a new build:

1. On the phone, with Tailscale connected, open `https://<machine>.<tailnet>.ts.net/`.
   Stark Code loads and asks this browser to pair. If you see "No static directory configured
   and no dev URL set." instead, the host's server has no web app bundled with it,
   which happens with a development server or a desktop build packaged without
   its web client. Pair from the desktop app instead, or install a build whose
   server includes the web client.
2. Open the pairing link on the phone. It signs in and lists the host's projects.
3. Start a task that asks for approval, answer it from the phone, and check that
   the host continues.

### What pairing grants

A standard pairing link, the default in **Create pairing link** and for
`stark-code pair`, lets the device do almost everything you can do on the host,
not only answer approvals:

| Permission                                      | What it allows                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| View environment (`orchestration:read`)         | Read threads, status, checkpoints, and configuration.                       |
| Operate tasks (`orchestration:operate`)         | Start, steer, and stop tasks, and answer approvals and questions.           |
| Change environment settings (`settings:write`)  | Edit preferences and keybindings, and save **Always allow** approval rules. |
| Manage providers (`providers:manage`)           | Configure, install, sign in to, and update providers and usage sources.     |
| Maintain environment (`environment:maintain`)   | Update the server and control its processes.                                |
| Control previews (`preview:operate`)            | Open browser previews and drive the host's browser.                         |
| View diagnostics and usage (`diagnostics:read`) | Read process diagnostics, resource history, and usage totals.               |
| View terminals (`terminal:read`)                | Read terminal output and status.                                            |
| Use terminals (`terminal:operate`)              | Create terminals and type into shells on the host, as your user.            |
| Change source control (`source-control:write`)  | Commit, push, manage branches and repositories, and change pull requests.   |
| Read files (`filesystem:read`)                  | Browse host files, search workspaces, and inspect local changes.            |
| Write files (`filesystem:write`)                | Edit workspace files and save plans to disk.                                |
| View relay (`relay:read`)                       | Inspect managed relay connectivity.                                         |

It does not include **View access** and **Manage access** (`access:read`,
`access:write`), which create pairing links and revoke other devices, or **Manage
relay** (`relay:write`).

For a device that should only follow and answer tasks, untick the rest under
**Permissions** when you create the link, or pass the scopes it needs:

```bash
stark-code pair --tailscale --scope orchestration:read --scope orchestration:operate
```

Without **Change environment settings**, the device can still approve once or for
the session, but not save an **Always allow** rule. See
[Manage or revoke access](#manage-or-revoke-access) to change or remove a device's
access later.

### Answer approvals from another device

Approval and question cards on web, desktop, and mobile take an answer only while
the device is connected and the chat is in sync with the host. Otherwise the
buttons are disabled and the card says why: **Reconnecting**, **Offline**, **Not
connected**, or **Syncing…**. They come back on their own once the connection is
live again. An answer is never queued while you are offline.

If the connection drops after you answer:

- The card keeps its spinner and says **Sending when reconnected**. When the device
  reconnects, Stark Code sends the same answer again. If the host had already
  received it, the host recognizes it and does not apply it twice.
- If the device does not reconnect within five minutes, the card says **Couldn't
  confirm your answer** and offers **Retry**, which sends that same answer again.
  Once reconnected, the chat shows whether it went through. Closing the tab or the
  app forgets an answer that was never confirmed; reopen the chat to see what the
  host has.
- The connection banner says when answers are waiting to be sent.

If someone answered on another device first, or the request expired or was
cancelled, the notice says so instead of showing an error. When the host reports
that it, or the agent, stopped before the agent received an answer, the notice
says the answer may not have reached the agent.

Thread history catches up after a drop. Web keeps a message you have not sent as a
draft, and the mobile app queues messages and sends them when it reconnects. A
host restart ends approvals that were waiting; questions the agent asked as a
message stay answerable.

## Stark Connect

Stark Connect, the hosted sign-in and relay, is not available in this build. Its
settings do not appear, `stark-code connect` reports that hosted cloud services are
not included, and features that depend on it, such as
[mobile push notifications](./mobile-notifications.md), are off. Use
[Tailscale HTTPS](#use-stark-code-from-your-phone-or-another-computer) to reach a
machine from elsewhere.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address
directly, for example on the same Wi-Fi network. Plain HTTP addresses do not give
browsers a secure context, so prefer
[Tailscale HTTPS](#use-stark-code-from-your-phone-or-another-computer) for phones.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
stark-code serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
stark-code pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, or SSH. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list. Pairing the same machine again over another
address also adds a route instead of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through a paired address, Stark Code also learns the machine's
current LAN and Tailscale addresses and adds them as routes, so pairing once over
Tailscale is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

Stark Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, Stark Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Hosted web app

This build has no public hosted web app. If your team deploys its own web client over
HTTPS, it also needs an HTTPS server endpoint. A hosted pairing link does not make an
unreachable backend reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Stark Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads Stark Code's server to `~/.stark-code/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that Stark Code launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the Stark home,
unless you already installed it from **Settings → Agents & accounts → Setup
doctor**. It is the same browser [HTML renders](html-renders.md) use, so a host
downloads it only once. Some Linux hosts need [setup](#browser-host-setup)
before it can start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo stark-code browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx stark-code browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `stark-code` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `stark-code` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries with apt. It is safe to run again. Without `sudo`, it
only reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `STARK_CODE_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Stark Code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `stark-code auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx stark-code pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`npx stark-code auth pairing create` and `npx stark-code auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens retain
standard client permissions and issued bearer sessions retain administrative
permissions.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, and environment maintenance can be granted
separately from access administration. New standard pairings include these
permissions. Existing clients can stay connected after an update, but newly separated
features may require pairing again with the permissions they need. Older clients
may show controls that the server denies. Create a fresh pairing link to change
a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Troubleshooting

| Problem                                                 | What to do                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The link does not open on the phone                     | Check that Tailscale is connected on the phone and on the host, in the same tailnet. Run `tailscale status` on the host.     |
| "No static directory configured and no dev URL set."    | The host's server has no web app bundled. See [Check the host before you rely on it](#check-the-host-before-you-rely-on-it). |
| "This machine has no MagicDNS name."                    | Run `tailscale up` on the host and turn on MagicDNS for the tailnet.                                                         |
| Setup says the HTTPS port already serves something else | Choose another HTTPS port in **Setup**, or pass `--tailscale-serve-port`.                                                    |
| Approval buttons stay disabled                          | The card says why. Wait for **Reconnecting** or **Syncing…** to clear, or choose **Reconnect** in the connection banner.     |

If the environment disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).
For a connection that still fails, check the date and time on both devices. For
server version warnings, follow [Updating Stark Code](./updating.md). Include the
diagnostic message and trace ID when reporting a persistent failure.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. Stark Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
