# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in Stark Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. Stark Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in Stark Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in Stark Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

Stark Code can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through Stark Code leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. Stark Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. Stark Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Reload MCP connections

Stark Code checks connection health at session startup and between turns. Codex
currently exposes only a global MCP reload, so Stark Code does not automatically
reconnect a failed server and disturb healthy connections. Failed remote connections
still get network and VPN checks. Sign-in failures show a sign-in action. Connection
controls wait until agent work has finished. A successful reload request is not proof
that every server connected; check the resulting server statuses.
The chat shows a connection notice only when a tool call in the current turn
needs that connection. Other issues remain available in connection settings.

In a live conversation in the local desktop app, open **+ → Connectors → Manage connections** and
choose **Reload MCPs**. This asks the running Codex provider session to reload its
MCP configuration; watch the server list for connection results. **Refresh status**
only rereads that list. No model turn is started.
This list reflects the provider's observations; it cannot prove that an otherwise
silent connection will answer its next tool call. An explicit discovery failure
is shown as failed even if the provider still labels the transport connected.
**Settings → MCP servers** can inspect connections, but cannot reload existing
conversations.

The native Codex terminal has separate connections and no live MCP reload command.
Its **Connections** control provides `/mcp` for inspection. Restart Codex and resume the
session to load changed configuration.

## Permissions

Codex chats run under **Supervised**: Codex asks before commands and file changes, and its sandbox
is read-only. A chat can instead use Codex's own settings, from your `config.toml`, its permission
profiles and rules. Choose **Reset to inherited** in the chat's permission popover; it needs
settings permission and applies once no run is active and Codex's session has restarted. The
popover shows the approval policy, sandbox, reviewer and permission profile Codex reported for the
running session; the approval policy keeps Codex's own word, such as `untrusted`, with its meaning
on hover. If your settings send approvals to Codex's automatic review, the conversation
shows what it approved or denied; Stark Code never turns automatic review on and never overrides
its denial.

An approval card offers only the choices Codex lists for that request. **Deny** (or **Deny and
stop** when Codex lists no plain Deny) and the narrowest allow Codex offers are the card's buttons;
the others are under **More approval options**, allows from shortest- to longest-lived, then
**Always block** and **Deny and stop**:

- **Allow once** and **Allow for this session**. Codex remembers a session approval until its
  session restarts.
- **Always allow (Codex, every project)**: a command-prefix rule saved in this Codex home's rules.
  The card shows the exact rule. A prefix that would allow too much, such as an interpreter, a
  shell or a network tool, is left out.
- **Always allow** or **Always block** one network host, saved in this Codex home's network rules.
- **Deny**, which refuses and lets Codex continue, and **Deny and stop**, which refuses and ends the
  turn. Codex takes no typed reason.

Saved rules apply to every project using that Codex home, need settings permission and are not
offered on mobile. A permissions request offers **Grant for this turn** or **Grant for this
session** for exactly the paths and network access the card lists, or **Deny**. Paths read as
Codex names them, such as `/ (the whole filesystem)`, a glob marked `(pattern)`, or `$TMPDIR`. For a Stark Pages
publish, Codex asks every time: session choices and saved allow rules are left out. If Codex closes a request
itself before your answer arrives, the card says so and nothing is sent.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request or
the current session; Stark Code does not offer permanent access, because Codex does not
say what it would save. When the request is about a tool call, the card shows that call
and its arguments. A form field the approval does not answer is never filled with a default;
if that field is required, the request is declined instead. See [Permission modes](./permission-modes.md) for command
and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
