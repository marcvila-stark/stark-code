# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent builds a self-contained HTML page, which appears in the thread above its written reply. It works with every provider, on web, desktop, and mobile.

Pages use your current theme, including custom themes, and follow light and dark mode as you switch. Scripts run inside the page, but it is sandboxed away from Stark Code and your session. Links you click in a page open in your browser. Use the expand button to open a page full screen. On web and desktop, use the zoom controls to see more detail.

Agents can place local images in a page by file path. Stark Code embeds them when the page is published, so the page keeps working after the original files move or are deleted. Deleting the thread deletes its pages.

HTML tools are not pre-approved as read-only actions. Preview pages cannot connect to websites, and generated replies block external images, fonts, scripts and data requests. Ask the agent to embed the content it needs. For a compact overview of a completed answer, choose **Make readable** beneath that reply. It adds a summary, table or flowchart above the original reply.

For a flowchart, sequence, state or other diagram, agents usually write a Mermaid diagram in their reply instead, which the chat draws without a tool call or approval. Mobile shows the diagram's source.

Before publishing, agents can check their work with screenshots from a small headless browser that Stark Code keeps for itself; it never uses a browser you installed. Stark Code installs it only when you ask: on web or desktop, open **Settings → Agents & accounts → Setup doctor** and choose **Install preview browser** (about 100 to 120 MB, into Stark Code's data folder). The same row shows its progress. Until it is installed, agents are told it is missing, so they publish without a screenshot check, draw a Mermaid diagram, or describe the page; a preview never downloads it. Browser tabs on a remote environment use the same browser, and opening one, yours or an agent's, downloads it if it is missing. Some Linux hosts need [setup](remote-access.md#browser-host-setup) before it can start. Pages publish without it.

## MCP apps

Some MCP servers return an interactive app with their tool results, following the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. When an agent calls one of those tools, the app appears in the thread in place of the tool call, on web, desktop, and mobile. Codex supports this today, for any MCP server you have configured for it; other providers show these calls as ordinary tool calls.

Apps follow your theme. An app can call tools on its own server and post a message to the thread; Stark Code asks first unless the server marks the tool as read-only, and it asks before every message. On mobile, an app also asks before opening a link, and Stark Code asks before saving a file an app offers. An app stays viewable after its agent stops, but using it needs the agent of the thread that created it running, so send a message in that thread first if the app says it is unavailable. An app that navigates away from its own page is stopped.

An app can open full screen; use the button in its top corner, or press Escape outside the app, to return it to the thread. Anything else that needs your attention, such as an approval, also returns it to the thread. On mobile, full screen opens the app again in its own screen, so anything the app does not save itself starts over. An app can also keep the agent informed of what you did in it, such as a filter you picked; Stark Code sends the latest note from each app with your next message.
