package expo.modules.starkcomposereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import org.json.JSONObject
import org.json.JSONArray

internal object StarkComposerClipboard {
  fun write(context: Context, text: String, fragment: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val payload = try {
      JSONObject(fragment)
    } catch (_: Exception) {
      null
    }
    val records = payload?.optJSONArray("records")
    if (payload == null || records == null) {
      clipboard.setPrimaryClip(ClipData.newPlainText("Stark Code", text))
      return
    }
    val all = (0 until records.length()).map { records.getJSONObject(it) }
    val selected = all.filter { text.contains("/${it.optString("contextId")})") }.toMutableList()
    val screenshots = selected.map { it.optString("screenshotContextId") }.toSet()
    selected.addAll(
      all.filter {
        screenshots.contains(it.optString("contextId")) &&
          !selected.contains(it)
      }
    )
    payload.put("records", JSONArray(selected))
    val encoded = java.net.URLEncoder.encode(payload.toString(), "UTF-8").replace("+", "%20")
    val escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    clipboard.setPrimaryClip(
      if (selected.isEmpty()) {
        ClipData.newPlainText(
          "Stark Code",
          text
        )
      } else {
        ClipData.newHtmlText(
          "Stark Code",
          text,
          "<pre data-stark-context-fragment=\"$encoded\">$escaped</pre>"
        )
      }
    )
  }

  fun read(context: Context): Map<String, String> {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = clipboard.primaryClip
    val item = if (clip != null && clip.itemCount > 0) clip.getItemAt(0) else null
    return mapOf(
      "text" to (item?.text?.toString() ?: ""),
      "html" to (item?.htmlText ?: ""),
      "fragment" to ""
    )
  }
}

class StarkComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarkComposerEditor")

    AsyncFunction("writeContextClipboard") { text: String, fragment: String ->
      StarkComposerClipboard.write(requireNotNull(appContext.reactContext), text, fragment)
    }

    View(StarkComposerEditorView::class) {
      Prop("controlledDocumentJson") { view: StarkComposerEditorView, documentJson: String ->
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { view: StarkComposerEditorView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("clipboardFragment") { view: StarkComposerEditorView, fragment: String ->
        view.setClipboardFragment(fragment)
      }
      Prop("placeholder") { view: StarkComposerEditorView, placeholder: String ->
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { view: StarkComposerEditorView, fontFamily: String ->
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { view: StarkComposerEditorView, fontSize: Double ->
        view.setFontSize(fontSize.toFloat())
      }
      Prop("lineHeight") { view: StarkComposerEditorView, lineHeight: Double ->
        view.setLineHeight(lineHeight.toFloat())
      }
      Prop("contentInsetVertical") { view: StarkComposerEditorView, contentInsetVertical: Double ->
        view.setContentInsetVertical(contentInsetVertical.toInt())
      }

      Prop("singleLineCentered") { view: StarkComposerEditorView, singleLineCentered: Boolean ->
        view.setSingleLineCentered(singleLineCentered)
      }
      Prop("editable") { view: StarkComposerEditorView, editable: Boolean ->
        view.setEditable(editable)
      }
      Prop("readOnly") { view: StarkComposerEditorView, readOnly: Boolean ->
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { view: StarkComposerEditorView, scrollEnabled: Boolean ->
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { view: StarkComposerEditorView, autoFocus: Boolean ->
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { view: StarkComposerEditorView, autoCorrect: Boolean ->
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { view: StarkComposerEditorView, spellCheck: Boolean ->
        view.setSpellCheck(spellCheck)
      }
      Prop("textPasteThresholdBytes") { view: StarkComposerEditorView, threshold: Int ->
        view.setTextPasteThresholdBytes(threshold)
      }
      Prop("maxInputChars") { view: StarkComposerEditorView, maxInputChars: Int ->
        view.setMaxInputChars(maxInputChars)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContextPress",
        "onComposerPasteContext",
        "onComposerPasteText",
        "onComposerContentSizeChange",
      )

      AsyncFunction("focus") { view: StarkComposerEditorView ->
        view.focusEditor()
      }
      AsyncFunction("blur") { view: StarkComposerEditorView ->
        view.blurEditor()
      }
      AsyncFunction("setSelection") { view: StarkComposerEditorView, start: Int, end: Int ->
        view.setSelection(start, end)
      }
    }
  }
}
