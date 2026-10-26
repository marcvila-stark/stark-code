# Claude

Stark Code offers Sonnet, Opus and Fable. Older saved Haiku selections use Sonnet 5.5
on the next app request; historical replies and usage keep their original model names.
Claude's background helpers and subagents launched by Stark Code are configured to
use Sonnet 5.5. Use Claude Code 2.1.284 or newer for that model and its subagent controls.
Native forks and skills that explicitly inherit the main model keep the main model.

This is an app launch policy, not a machine-wide model restriction. The unmodified
native CLI still owns its `/model` command and personal settings, and opaque gateway
model names cannot be identified by Stark Code. Strict organization-wide restrictions
need Claude's managed settings. Stark Code does not edit your personal or managed settings.

Stark Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Switch organizations on the shared login

Open **Claude organizations** at the bottom of the sidebar to switch quickly.
Choose a saved organization directly; the checkmark and sidebar label update after
the switch succeeds. **Manage organizations** opens the setup and automatic
switching controls for the same machine. The picker follows the current
conversation's machine, including remote conversations.

Install [claude-swap](https://github.com/realiti4/claude-swap) 0.25 or newer on the connected
environment's machine first (`uv tool install claude-swap`). Load organizations to
see saved logins, usage windows, and reset times. Organizations with the same email
stay separate.

To save another organization, use `/login` in Claude Code on that machine, select
the organization, then choose **Save current login** in Stark Code. Saving captures
that sign-in; it does not open an OAuth flow. Credentials remain in claude-swap's
credential storage and are never sent to the app's browser.

To remove a saved organization, use `cswap list` and `cswap remove <number>` in
Terminal. Review its confirmation: removal also deletes that organization's
isolated cswap session history and directory mappings. It leaves the current
shared Claude login signed in.

Switching changes the machine's shared Claude login, including other terminals
and editors using it. Running Claude processes may keep cached credentials briefly;
a selected organization is not proof that an in-flight request has changed accounts.
Separate configuration directories and explicit API keys or token overrides do not
follow this switch.

Automatic switching is off by default. Choose which saved organizations are eligible
and the usage percentage that should trigger a switch, then confirm the shared-login
scope. The switcher checks account and model limits and excludes API-key accounts.
An exhausted model can trigger switching even if you are using a different model.
Eligibility is shared with claude-swap outside Stark Code. Avoid running another
claude-swap automatic switcher at the same time.

Automatic switching runs while the Stark Code server is running and stops when that
server quits. On a remote environment, closing the desktop window does not stop the
remote server. Turn automatic switching off explicitly when needed. It changes the
login for subsequent requests; it does not replay a failed prompt, restart a terminal,
or retry tool actions. Usage that is unavailable or stale is not shown as unused quota.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
Stark Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## MCP servers

Open the thread's **MCP** panel to inspect connected servers and available tools.
The local desktop app can reconnect, enable or disable, sign in, or sign out when
Claude supports the action. **Settings → MCP servers** also works without an open
thread. Remote clients can view cached status but cannot start a cold inspection
session or change server connections.

Stark Code checks MCP health when a chat session starts and between turns. It
reconnects only failed servers, spacing repeated attempts up to five minutes apart.
Healthy connections keep their prompt cache. Recovery waits for active turns and
tool calls; detached background shells can keep running. A message sent during a
reconnect waits for it to finish. Sign-in failures show a sign-in action instead
of retrying. For remote servers, Stark Code checks Tailscale first for tailnet
addresses and FortiClient on macOS for other network failures. A confirmed
disconnected VPN pauses reconnection; other network failures retry slowly.
The chat shows a connection notice only when a tool call in the current turn
needs that connection. Other issues remain available in connection settings.

In a live conversation, open **+ → Connectors → Manage connections** and choose
**Reload plugins** to apply installed plugin changes. This does not download newer versions.
Its follow-up reconnects only failed servers. Disabled servers stay disabled. If Claude
reports that a plugin change affects its prompt cache, choose whether to apply it;
applying it can increase input-token usage on the next turn. The reload itself
does not send a message to the model. **Refresh status** checks connection health
without reloading plugins.
Adding or removing a plugin MCP server in chat may still require a new session;
Claude's native terminal can apply those changes through `/reload-plugins`.
Reload is available from a live conversation; Settings only inspects its own
separate connection and cannot reload existing conversations.

Native shells have separate connections. Their **Reload plugins** control lets you
copy `/reload-plugins`; paste it at an empty, idle terminal prompt and press Enter.
It does not submit the command for you or force a cache-changing reload.

## Context details

Open **Details** from the context meter for Claude's context breakdown. The summary
does not send a model request. **Count exactly** requests a full count explicitly;
it can use the provider's counting API. Without a live session, totals from the last
turn are labeled as totals rather than a current context-window measurement.

## OpenRouter

Open **Settings → Agents & accounts → Connect OpenRouter**, enter an OpenRouter API
key, and save. Stark Code stores the key as a sensitive provider secret and creates
an isolated Claude Code configuration for that connection. Your normal Claude
login and organization stay separate. Claude Code must be installed; an extra agent
runtime is not required. OpenRouter usage is billed to that key, not your Claude subscription.

Choose **OpenRouter** in the chat model picker, then search for a model. The list
comes from OpenRouter's public catalog and includes text models that support tools.
The full routed ID, such as `anthropic/claude-sonnet-5.5`, is preserved. Anthropic
models have the best Claude Code compatibility; other tool-capable models may differ
in supported agent behavior. Haiku is excluded. Helpers use Sonnet through OpenRouter.

If catalog discovery is unavailable, Sonnet remains available and you can add an
exact model ID in the connection's custom models. Replace the key from the same
connection settings. The connection check validates the key without generating a
model response; Claude subscription usage is not shown for OpenRouter.

Existing manually configured OpenRouter Claude instances are still recognized by
`ANTHROPIC_BASE_URL=https://openrouter.ai/api`. Their API key belongs in
`ANTHROPIC_AUTH_TOKEN`, marked Sensitive, with `ANTHROPIC_API_KEY` explicitly empty.
Keep a dedicated configuration directory. Never log out your normal Claude account
to configure OpenRouter.

See the [official OpenRouter Claude Code guide](https://openrouter.ai/docs/guides/guides/claude-code-integration)
and [model catalog reference](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.

## Setup diagnostics

In **Settings → Agents & accounts → Setup doctor**, existing provider reports show
which profiles are installed, enabled and signed in. Choose **Inspect connections**
to inspect MCP status for the selected folder and check the Pages kit and sign-in
on this desktop. These checks do not install software, sign in, reload connections
or request a model response. A Pages sign-in is not proof that every page is accessible.
Use **Open Connected tools** for a connection that needs attention.
