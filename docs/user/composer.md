# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

## Reading replies

Assistant replies use a readable column with clearer headings and spacing. Adjust
text size in **Settings → Appearance**. Long replies with at least three headings
or standalone bold section labels gain a contents list after they finish.
Code, tables and diagrams keep the space they need.

## Formatting

The composer writes Markdown and shows it styled as you type. Markers such as
`**` stay in the text and show beside the styled words when your cursor is on
them. Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---` become lists,
task lists, quotes, headings and rules; ` ``` ` followed by Enter opens a code
block. What you typed is what the agent receives, markers and numbering
included, and `#1234` without a space still looks up a pull request.

Enter sends. In a list or quote, **Shift+Enter** continues it, and Shift+Enter
on an empty line leaves it; **Tab** nests a list item. In a code block, Enter
starts a new line at the current indentation, **Tab** and **Shift+Tab** indent
the selected lines, and a closing ` ``` ` followed by Enter, or two blank lines
at the end, leave the block. **Backspace** at the start of a code block turns it
back into plain lines. Choose the language in a code block's corner to change
it. Very large code blocks are shown without syntax highlighting.

## Attach files

On web and desktop, open **+ → Add files or photos** to upload files. Type `@`
to reference a file or folder already in the selected workspace, including a remote
workspace. Folder references do not upload their contents. Paste a GitHub issue URL
directly into your draft to reference an issue.

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. A video attachment gives
the agent a file path; it does not enable native video input.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to Stark Code through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, choose **Settings → General → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited, reordered, or removed above the composer.
`Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses the opposite action:
it steers when your default is Queue and queues when your default is Steer.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Follow-ups**. While a turn is
running the send button shows which action it will take. Long-press it to use the
other action for a single message, or hold `Cmd` while sending from a hardware
keyboard. The button only offers Steer when the running agent supports it.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of Stark Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

To rename a built-in model on every client, edit the server's `settings.json` in its `userdata`
directory. Add a custom model entry with the built-in model ID and a new name under that provider
instance:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Model defaults

Stark Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection. Before you have picked one, or when the
remembered provider can no longer run, new threads start on Claude if it is
signed in and ready, otherwise on the first provider that is.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

You can also quote selected text from the native **Read view** and **Pages**, including a page
opened in a full tab. Choose **Quote in chat** to return to your existing draft.
For native Claude or Codex terminal output, hold **Shift** while dragging to select
text, then choose **Quote in chat** from the selection menu. The terminal keeps
running. Quoting never sends your message or types into the terminal.

Page and native Read view quotes keep the selected text and its source in a compact
chip. Open it to read the full excerpt or remove it, then write your question
alongside it. Selections are limited to 8,000 characters; shorten a longer
selection rather than losing part of it.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Restore chat only** to keep
workspace files, **Restore code and chat** to restore both, or **Restore code only**
to keep the conversation. The selected prompt returns to the composer when you
restore chat; any unsent draft stays above it.

In a shared project directory, file restore previews the agent's recorded edits
and keeps files changed since, links, and unrelated files. Shell-command edits
and background-agent edits are not tracked. Restore is unavailable while the
workspace has an active turn. A non-Git Claude project needs native file
checkpoints. After restoring files, use **Undo restore** to return eligible files
to their prior contents; files changed since the restore are kept.

An isolated worktree can also restore its whole checkpoint. Do this only when you
want the worktree to return to that earlier state.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Provider voice on desktop

The microphone opens the selected Claude or Codex native session and its **Voice**
controls. Your chat draft stays saved. The native session has its own conversation;
voice does not insert a transcript into the chat composer.

At an empty, idle CLI prompt, choose **Prepare /voice hold** for Claude or
**Prepare /voice** for Codex, then press Enter in the terminal. Preparing stages
the command without submitting another draft or answering a permission prompt.

Claude uses its own transcription service and Claude account. Hold Space to speak,
release to review the transcript, then press Enter to send it. Its terminal shows
microphone activity and transcription. Esc cancels dictation; `/voice off` disables
it. API-key-only Claude sessions do not support this voice service.

Codex `/voice` starts a voice conversation through your ChatGPT account and can act
on spoken instructions. Use `/voice settings` for devices and `/voice` again to
stop. Voice availability depends on the installed CLI and account.

The provider owns recording, permissions and cancellation. Voice uses the microphone
on the computer running the CLI; a remote server cannot use this Mac's microphone.
The desktop composer no longer starts macOS speech recognition.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Voice input records from the first connected microphone in **Settings → Microphone**.
The list mixes kinds (built-in, other wired, other Bluetooth, CarPlay) with wired and
Bluetooth devices you have dictated with, listed by name. Drag to rank them together:
for example, put **Other Bluetooth** above your AirPods so a new headset is preferred
while the AirPods microphone stays low. By default, CarPlay comes after the built-in
microphone.

Transcription runs on your device. Stark Code deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a steer arrow. Click it to send a message into
the active turn, or press `Enter` on desktop. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to
switch the button to a queue icon. Click while holding that key, or press `Cmd+Enter` or
`Ctrl+Enter` on desktop, to queue the message for after the active turn.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

If the server restarts, saved queued messages keep their order and are held. Press
**Resume** in an empty composer on web or desktop, or **Resume queue** in the queue
sheet on mobile, to continue. You can edit, reorder, or remove held messages without starting them.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Alongside **Add files or photos** and **Connectors**, the **+** menu offers searchable **Slash commands** and **Skills**
for the selected provider. Skills and provider commands are added to the draft;
app commands such as `/model` open the relevant control without sending it. To
install or manage plugins, use the native agent's manager in Shell mode: `/plugin` for Claude
and `/plugins` for Codex. The skills picker includes invocable plugin skills;
the native manager shows the full installed-plugin inventory.

For Claude and Codex, **+ → Connectors** shows reported MCP connections. Open
**Manage connections** for sign-in, reconnection, and reload controls. Changes to
Claude connections apply to the project; Codex changes are saved in Codex settings
and can affect other sessions. Remote clients show status; make changes on the
desktop host. If the session is not running, use **Inspect project connections**
on the desktop host to load the project's configured tools without sending a message.

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

In a live Claude session, the menu uses Claude's current commands, skills, and MCP
prompts, including plugin commands. Before a session starts, it shows the available
filesystem catalog. If installed commands have changed but the session still lists
the old set, use **Restart agent session** in the command palette. Opening the menu
does not start an agent session.

Provider commands must start the message to run. Stark Code commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Run a shell command

On web and desktop, type `!` at the start of an empty Codex or Claude composer,
then enter a command. It runs in a fresh login shell in the thread's working
directory. Shell commands do not retain directory changes or shell variables
between runs; use the terminal for a continuing shell session.

**Respond** runs the command and asks the agent to use its output. **Just run**
records the output for later context without requesting a reply. Hold Option on
macOS or Alt elsewhere while sending to use the other choice for that command.
Use Stop to cancel a running command. Long output is saved as a file; the message
shows a limited preview and a link to the full output.

Queued shell commands run in order and cannot be edited or promoted to a steer.
The environment can disable this feature or change its ten-minute timeout in
server settings.

## Tools beside your chat

Use **Tools** to open Pages, Side chat or Terminal. Less common workspace
tools are under **More tools**. Switching tools keeps your open pages and
side-chat draft in place. Expand a panel to read across the app, or close it to
return to the conversation.

**Terminal** runs shell commands beside the chat. **Agent shell** opens the native
Claude or Codex program in the main conversation area. **Terminal below chat**
controls the separate bottom drawer. Chat details, including branch and working
folder controls, are also available in Tools. **Hide chat details** at the bottom
of the card hides it in every chat, even after a restart, until you choose
**Tools → Chat details** again.

## View Stark Pages

In the local Mac app, choose **Tools → Pages** from a thread. The chooser switches between
**Company pages**, shared through Stark Pages, and **Local pages**, built on this
Mac in the current chat's folder. It remembers your choice and keeps your open page and reading
position when you switch.

Company pages opens the Stark Pages website inside the desktop app. Use **Expand Pages**
to fill the window, then return it to the side panel when you want to see the chat.
The website reuses **Personal imported sessions** on this Mac. If you already imported
your Stark Pages sign-in, opening Pages uses it automatically. Otherwise choose
**Import sign-in from browser**, pick your browser and the sites to copy, then confirm.
Nothing is selected automatically. You can also use the website's normal Google sign-in.
Saved sessions survive app restarts, subject to the site's expiry and sign-out rules.
Clearing Personal imported sessions signs Pages out too. Agent-controlled tabs cannot
use this personal profile.

The **Use connected library** option is available while signing in or when the website
cannot load. That library uses the Pages connection: its sign-in opens in your main
browser and returns to Stark Code. The app restores and renews that connection when
the server allows. In the library, open a project's preview or search across Company
pages. Related page links stay in its reader; other links open in your main browser.
Choose **Show Pages website** to return to the website.

Choosing Local pages starts the built-in Stark Workbench preview automatically. No
separate setup is needed. If the preview cannot start, use **Retry Pages**. In
Claude native shell mode, **Publish** prepares its command in the terminal for
you to review and submit. It does not submit the command automatically. Other
modes keep publishing unavailable.

Opening a company page from the connected library gives it a tab beside **Chat**, using the full reading
area. For a folder preview, choose **Open page in tab**. Switch back to Chat
without losing your draft or the page's reading position; closing a page returns
you to Chat. Pages are added only when you open them. You can still expand or
resize the Pages chooser to browse beside your conversation.

The connected library includes styles, images and fonts stored with the page. Viewing
uses no model tokens. Recent pages are cached temporarily. The **Page actions**
menu contains **Refresh page**, **Open in browser**, and **Disconnect Pages**.
This view is read-only and does not run page scripts or load resources from other
websites. Open interactive pages in your browser. Disconnecting removes the saved
connection and clears cached pages.

## Goals

With Codex and Claude, send `/goal` followed by what "done" means, for example
`/goal all tests in packages/api pass`. The agent keeps working across turns
until it judges the goal met. The thread shows **Goal** while it works, and a
row above the composer shows the goal and its progress.

- `/goal` alone shows the current goal. `/goal clear` removes it.
- Codex also supports `/goal pause` and `/goal resume`. Stopping a Codex goal
  pauses it.
- Stopping Claude ends the current turn, but the goal stays set. Claude checks it
  again at the end of your next message.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or on web and desktop drag a thread out of the sidebar and drop it on the
composer; a multi-selection drops together. The chip shows the thread's current title and
opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete Stark Code tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your Stark Code session.

The file viewer recognizes images, HTML, and PDF files by their filename extension,
including filenames or folders containing `#` or `?`.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
