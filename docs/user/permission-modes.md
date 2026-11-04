# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

New Claude chats inherit Claude's own permission settings: Stark Code sends no mode, so Claude's
user, project, local and managed settings decide. New chats on other providers use the Stark
preset set in **Settings → General → New threads → Permissions**; projects can override the
environment default, and the initial preset is **Supervised**. New threads use these defaults
rather than the mode of the thread you were viewing. Picking a mode in a new chat's composer
overrides the provider's settings for that chat. Existing threads keep their permissions.
Without permission to change settings, modes wider than the narrowest stay in the picker but are
disabled with **Needs settings permission**.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Inherited or overridden

The shield chip beside the mode control reads **Inherited** when a chat uses its provider's own
permission settings and **Overridden** when it uses the mode you chose. On a narrow window the
chip shows only its icon, a shield with a check for Inherited and a shield with a person for
Overridden; hover or focus it for the name. Picking a mode for a saved chat updates the chip and
the picker at once, and the popover says **Saving this change…** until Stark Code confirms it.
Open the chip to see:

- what the provider reported for the running session, marked **Effective**. Codex's approval
  policy keeps Codex's own word, such as `untrusted`; hover it for what it means;
- values read from the provider's settings files, marked **Configured**: the next launch reads
  them, but they are not proof of what runs. A setting no file sets shows the provider's default,
  such as "Not set: Claude starts in Manual";
- anything the provider does not report, marked **Unknown**;
- the boundaries Stark Code keeps whatever the provider allows, marked **Stark policy**.

**Reset to inherited** hands the chat back to the provider's settings once no run is active. It
needs settings permission, because the provider's settings can allow more than the chat's mode.
**Override for this chat** switches an inherited chat to a Stark preset. A narrower mode
chosen while the agent is working applies after the run stops, and the popover says what the
running session keeps until then; **Stop and apply now** stops the run and applies it at once.
Stark Code sets a chat saved with a mode that is no longer available to the narrowest mode when it
starts or when the mode is turned off. A server from before this change instead shows the mode
the chat runs as and what was saved, with **Save as** to keep it.

**Settings → Permissions** lists where each provider's new chats take their permissions from and
the Stark policies. The native terminal keeps its own launch arguments either way.

## Claude modes

Claude's composer uses the same mode names as its terminal: **Manual**, **Accept edits**,
**Auto**, **Plan**, and **Bypass permissions**. Choose **Plan** to explore before making
changes; select a working mode to leave planning. New chats inherit Claude's own settings until
you pick a mode; **Manual** is the preset a chat uses when it can't inherit. Mode changes apply
to the next turn. Auto uses Claude's own action review and can still ask
you for approval. Your organization's Claude settings can restrict which modes are available.

Claude decides what needs approval; Stark Code shows every approval Claude asks for, in every
mode, and never answers one for you. When Claude switches into plan mode by itself, the chat
stays in plan mode until you choose **Implement** on the proposed plan, which returns it to the
mode it had before. An approval a background agent asks for after a reply has finished still
appears in the thread. If your Claude settings turn hooks off, they stay off in Stark Code;
Stark Code's own checks still apply.

Bypass is hidden until you enable **Allow Bypass permissions** in that Claude account's
provider settings and confirm. Selecting it for a chat asks again. It cannot be a new-chat
default, and child agents, forks and scheduled new chats do not inherit it: while a chat is in
Bypass, its agents' actions are refused (a Stark Code rule, not Claude's). Even in Bypass,
anything Claude still asks about, such as an action matching one of your ask rules, comes to
you. Turning **Allow Bypass permissions** off sets every Bypass chat on that account to Manual
straight away, stopping one that is running; turning it back on does not restore Bypass.
Publishing to Stark Pages is off in Claude chats in every mode; use native shell mode to
publish.

In native shell mode, use Claude's own mode controls, including **Shift+Tab**. Explicit
permission modes in the provider's launch arguments are honored; flags that bypass
permissions require the same account opt-in. Child agents cannot run in Bypass.

## Codex permissions

Codex chats run under **Supervised**: Codex asks before commands and file changes, and its
sandbox is read-only. A Codex chat can instead use **Codex's own settings**, from your Codex
`config.toml`, its permission profiles and its rules. Stark Code then sends Codex no approval
policy, reviewer or sandbox. If those settings route approvals to Codex's automatic review, the
conversation shows what the review approved or denied; Stark Code never overrides a denial for you.

Codex approval cards offer only the choices Codex offers for that request. **Deny** refuses and
lets Codex continue; **Deny and stop** refuses and ends the turn. **Always allow** saves a Codex
rule, either a command prefix or a network rule for one host, and **Always block** saves a network
rule that blocks one host; each applies to every project using that Codex home and needs permission
to change settings. The card shows the exact rule, and Stark Code leaves out rules that would allow
too much. A permissions request grants exactly the access Codex asked for, for the turn or for the
session, and the card lists those paths and any network host before you choose.

Codex keeps a turn's settings for its later turns and remembers session approvals until its
session restarts. If you narrow a chat's permissions while Codex is working, either stop the run
to apply the change now or let it apply after the run stops; Codex starts no further goal turn
under the old settings. A chat that ran under Supervised switches to Codex's own settings only
after its Codex session restarts and Codex reports that Supervised no longer applies.

## Command approvals

A command approval leads with what the command does when Stark Code can tell from its text, and
the exact command stays visible or one click away, including the shell wrapper Codex adds. Claude's
own summary of the command, such as "Create build directory and write timestamp", appears as text
under the card's title; the exact command is the card's only text you tab to. An approval a
Claude subagent asks for names the subagent and shows its command. When a hook forced the ask, the
card says **Asked by a hook**, and a command Stark Code cannot tell from a Stark Pages publish says
it needs your approval each time. A command is
marked **Read-only command** only when every part of it is a known reading program, such as `cat`,
`ls`, `grep`, `find`, `sed -n` or `git status`, with no output redirection, substitution, `xargs`
or option that writes or runs another program. The card then says what the command is expected
to do. This is a reading of the command text, not a guarantee: aliases, shell startup files,
environment variables and repository settings such as Git helpers can still run other programs
that write files or use the network. Read-only commands still ask for approval in modes that ask
for commands.

## File change approvals

For Claude and Codex, a file change approval lists the files the agent wants to write and shows the
proposed diff of each, so you can review the change before allowing or declining it. On a narrow
card a long path shortens its folders first and keeps the file name whole.

For a Claude edit, Stark Code reads the current file to place the diff, but only a text file of at
most 1 MB inside the thread's folder, reached without symbolic links. Otherwise the diff is built
from the edit alone and its line numbers are marked approximate. The folders on the way are checked
before and after the read, but a program that swaps one for a link and back again during the read
can still put another file's text in the preview.

## Approval choices

Each choice says how long it lasts. A tag (**Once**, **This turn**, **This session**) appears
only when the choice's name doesn't already say it; **This session** lasts until the provider
session ends and saves nothing. A **Saved** choice is written to a settings or rules file for later
sessions: it shows the exact rule and one line saying where it is kept. Only choices the provider
offers appear; when the provider offers none, the card says **No choices offered** and the
request closes when the agent stops waiting. An app's approval says where the app is configured,
such as your user settings, this project's settings or Stark Code. The plain decline
(or **Decline and stop** when no plain decline is offered) and the narrowest allow offered (once,
else this turn, else this session; never a saved rule) are buttons; the rest are under **More approval options**, allows from shortest- to longest-lived,
then the other declines. **Decline and stop** declines and stops the run. Where the provider accepts one, **Decline with a reason…** sends your
reason to the agent.

After you answer, Stark Code tracks whether the answer reached the agent. Until the agent confirms
it, the conversation names your choice as selected, such as **Allow once selected · sending…**;
**Allowed once** appears only once the answer arrived. **Answer not delivered** means nothing ran,
so ask again if the step is still needed. **Delivery uncertain** means the answer may or may not
have arrived; check whether the step ran before asking again. If the agent later confirms an
uncertain answer, the conversation shows it as arrived. A command you declined, or whose
approval expired or was lost before you allowed it, never ran: the work log says **Declined 1
command** and Run evidence says **1 command declined**, not that it ran or failed. A file change
you declined was not written: Run evidence says **1 file change declined**, not that the
evidence is incomplete.

## Remember an approval

When an approval supports a saved rule, review the exact tool or command prefix and
its scope before remembering it. A saved command prefix can allow later commands
with different arguments. A saved choice without an exact rule is not offered, and
one needs settings permission to pick; the mobile app does not offer saved choices. **Settings → Permissions** lists saved rules and lets
you forget them. Stark Pages publishing is never remembered: Codex asks every time, and
Claude chats refuse it.

Claude skills and plugin commands can declare tools that Claude permits before
Stark Code receives an approval request. The composer warns about this when you
select a skill or plugin command. Choose it only if you trust its tool permissions.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval. A Codex chat already set to another mode runs in **Supervised**; see
[Codex permissions](#codex-permissions).

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

Claude approvals offer **Allow for this session** only when Claude suggests a session permission,
and the choice grants exactly that suggestion, which the card describes, such as a command prefix,
an extra folder or a mode switch like allowing edits without asking. It lasts until Claude
restarts, for example after a mode or model change. **Decline and stop** refuses the action and
ends Claude's current work; with either decline you can add a reason, which Claude receives.

ACP Registry agents run their own tools in their own mode; Stark Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
