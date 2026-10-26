# Terminals and native agent shells

## Native shell mode

On web and desktop, choose native shell mode in a Codex or Claude thread to use
the installed command-line program inside Stark Code. Its commands, plugins, and
terminal interaction come from that program. The terminal session keeps its
working directory and shell state until it exits.

Codex native shells start read-only and ask for approval. An explicit
`--sandbox workspace-write` provider launch argument permits workspace writes;
full-access bypass flags and unknown launch arguments are refused. Configure
launch arguments in **Settings → Providers**.

On macOS, **Settings → General → Native shell** controls extra non-secret login
shell variables imported when the app starts. `AGENT_WORKSPACE` is included by
default. Restart Stark Code after changing this list.

### Reload MCPs and plugins

Claude's connection controls offer `/reload-plugins` to apply plugin changes
and `/mcp` to inspect or reconnect individual servers. The commands are copied
for you to paste at an empty CLI prompt and run.
They do not clear your input, submit a prompt, or restart the terminal. Claude may
ask before applying plugin changes that increase the next turn's token cost.

Codex's **MCPs** menu offers `/mcp` for inspection. Its terminal does not support
a live reload command; restart and resume Codex to pick up changed configuration.
The MCP reload control in chat mode affects the chat connection, not this terminal.
If a native Claude tool call reports a recognized connection or sign-in failure,
a notice lets you return to the terminal. Startup connection listings stay in the
terminal. **Connection help** remains available for either agent.
Stark Code never types a recovery command into your
CLI, submits a prompt, or restarts it automatically.

### Read completed native replies

Choose **Read view** above a native Claude or Codex terminal to read completed replies
with headings, tables, comfortable spacing, and local screenshots. Replies appear
in capture order; new replies do not replace the one you are reading. Choose **Both**
to keep the same terminal beside the transcript; on narrow windows they stack.
**Fill window** gives either view the whole window. Changing views preserves the
terminal session and your reading position. Escape restores the workspace when
focus is in the expanded Read view; inside the terminal it remains a CLI key.

Select text in any reply to quote it into an unsent chat draft. Screenshot paths
inside the current folder appear inline;
paths in code examples and outside the folder stay as text or links. Explicit
Markdown images continue to work.

Opening Read view uses no AI tokens. **Make readable** beneath a reply adds a
useful overview, table, or flowchart in place. It uses one bounded Sonnet call for
only that reply, caches the result, and keeps the original below. **Show original**
hides the additions; choosing Make readable again reuses the saved result.

Start a new native session after updating to enable capture. Codex may ask you to
review and approve Stark Code's local Stop hook first; its existing hooks and
Computer Use notification stay in place. Only completed replies are captured:
streaming and interrupted replies may be absent, and asynchronous replies can
arrive late. Capture does not copy terminal history or add anything to the chat.
Very long replies are shortened in Read view and marked; the full reply stays in
the terminal. If capture is unavailable, the native terminal still opens.
Remote images in Read view load only after you choose to load them.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Stark Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when Stark Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.
