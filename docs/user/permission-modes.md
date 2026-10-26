# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Supervised**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Claude modes

Claude's composer uses the same mode names as its terminal: **Manual**, **Accept edits**,
**Auto**, **Plan**, and **Bypass permissions**. Choose **Plan** to explore before making
changes; select a working mode to leave planning. Manual remains the initial default, and
mode changes apply to the next turn. Auto uses Claude's own action review and can still ask
you for approval. Your organization's Claude settings can restrict which modes are available.

Bypass is hidden until you enable **Allow Bypass permissions** in that Claude account's
provider settings and confirm. Selecting it for a chat asks again. It cannot be a new-chat
default, and child agents, forks and scheduled new chats do not inherit it. Publishing
still asks for approval.

In native shell mode, use Claude's own mode controls, including **Shift+Tab**. Explicit
permission modes in the provider's launch arguments are honored; flags that bypass
permissions require the same account opt-in. Child agents cannot run in Bypass.

## Remember an approval

When an approval supports a saved rule, review the exact tool or command prefix and
its scope before remembering it. A saved command prefix can allow later commands
with different arguments. **Settings → Permissions** lists saved rules and lets
you forget them. Stark Pages publishing always requires a fresh approval.

Claude skills and plugin commands can declare tools that Claude permits before
Stark Code receives an approval request. The composer warns about this when you
select a skill or plugin command. Choose it only if you trust its tool permissions.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; Stark Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
