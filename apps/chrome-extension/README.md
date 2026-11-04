# Stark Code Capture preview

Add selected text, an image or a screenshot region to a chosen Stark Code chat draft, with its source page URL. Choose an existing chat or a new chat in a project. Adding a capture preserves the draft and leaves the agent waiting for your normal **Send** action.

This preview supports Chrome on macOS and needs a desktop build that includes Chrome Capture. Get the current preview from the [Stark Code download page](https://pages.starkfuture.com/stark-code/index.html).

## Connect

1. Run `node apps/chrome-extension/build.mjs` from the repository root.
2. In Chrome's extension management page, enable Developer mode, choose **Load unpacked**, and select `apps/chrome-extension/dist`.
3. Copy the extension ID from Chrome's extension details, or from `dist/extension-id.txt`.
4. In the matching Stark desktop app, open **Settings → Connected tools → Browser & privacy → Chrome capture**, paste that ID and choose **Connect Chrome**. This connects Chrome to that specific Stark profile. Disconnect there to remove the connection.

## Capture

- Select text, or right-click an image, and choose **Send selection/image to Stark Code**.
- For a screenshot, open the extension and choose **Capture region**. Drag a rectangle, then use the capture or cancel. You can assign its shortcut in Chrome's extension shortcut settings.
- Review the preview, source link and optional note. The open Stark chat is suggested. **Change** lets you search recent chats or select **New chat**. For an older chat outside the recent list, open it in Stark, then return to the extension.
- Choose **Add to draft**. A receipt appears after Stark saves it. Open Stark to review the context and send when ready.

Chrome may prevent reading an image's original pixels. A supported fallback captures its visible area and is labeled **Captured from the visible page**. For an off-screen image, a restricted page or an embedded frame, select a visible screenshot region instead when Chrome permits it.

## Pending captures

If Stark is closed or a delivery reply is lost, keep the capture and retry. Once delivery starts, its target is pinned. Changing that target first cancels the earlier delivery; if Stark is already saving it, wait for its receipt. Deleting pending delivery also waits for cancellation, so a capture cannot disappear from Chrome while being silently delivered elsewhere.

Pending captures stay in this browser profile, with up to 20 captures / 50 MB. This preview accepts text selections up to 6,000 characters, notes up to 1,000 characters and images up to 4 MB. It reports limits rather than shortening selected text. Sending from Stark follows the selected environment's ordinary attachment, provider and permission flow.

## Local checks

Run `node --test apps/chrome-extension/tests/*.node-test.mjs` from the repository root. The checks exercise capture validation, zoom/Retina crop coordinates, pending storage, pinned delivery and retry/cancellation. Real Chrome and desktop verification is a separate integration check.
