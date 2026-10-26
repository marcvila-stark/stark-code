import ExpoModulesCore
import UIKit

enum StarkComposerClipboard {
  static let fragmentType = "app.stark-code.context-fragment"

  static func write(text: String, fragment: String) {
    var items: [String: Any] = ["public.utf8-plain-text": text]
    if let data = fragment.data(using: .utf8),
       var payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let records = payload["records"] as? [[String: Any]] {
      var selected = records.filter { record in
        guard let id = record["contextId"] as? String else { return false }
        return text.contains("/\(id))")
      }
      let screenshots = Set(selected.compactMap { $0["screenshotContextId"] as? String })
      selected.append(contentsOf: records.filter { screenshots.contains($0["contextId"] as? String ?? "") && !text.contains("/\($0["contextId"] as? String ?? ""))") })
      payload["records"] = selected
      if !selected.isEmpty, let encoded = try? JSONSerialization.data(withJSONObject: payload), let raw = String(data: encoded, encoding: .utf8) {
        let attribute = raw.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        items[fragmentType] = encoded
        items["public.html"] = Data("<pre data-stark-context-fragment=\"\(attribute)\">\(escaped)</pre>".utf8)
      }
    }
    UIPasteboard.general.items = [items]
  }

  static func read() -> [String: String] {
    let board = UIPasteboard.general
    return [
      "text": board.string ?? "",
      "fragment": board.data(forPasteboardType: fragmentType).flatMap { String(data: $0, encoding: .utf8) } ?? "",
      "html": board.data(forPasteboardType: "public.html").flatMap { String(data: $0, encoding: .utf8) } ?? "",
    ]
  }
}

// Expo Modules 2.0: the clipboard function is a @JS member; the view stays in
// definition() until the 2.0 view API lands.
@ExpoModule("StarkComposerEditor")
public class StarkComposerEditorModule: Module {
  // UIPasteboard is main-thread only, so the member is main-actor isolated.
  @JS
  @MainActor
  func writeContextClipboard(text: String, fragment: String) async {
    StarkComposerClipboard.write(text: text, fragment: fragment)
  }

  public func definition() -> ModuleDefinition {
    View(StarkComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: StarkComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: StarkComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("clipboardFragment") { (view: StarkComposerEditorView, fragment: String) in
        view.setClipboardFragment(fragment)
      }
      Prop("placeholder") { (view: StarkComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: StarkComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: StarkComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: StarkComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: StarkComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: StarkComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("readOnly") { (view: StarkComposerEditorView, readOnly: Bool) in
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { (view: StarkComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: StarkComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: StarkComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: StarkComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }
      Prop("submitTitle") { (view: StarkComposerEditorView, title: String) in
        view.setSubmitTitle(title)
      }
      Prop("alternateSubmitTitle") { (view: StarkComposerEditorView, title: String) in
        view.setAlternateSubmitTitle(title)
      }
      Prop("enterBehavior") { (view: StarkComposerEditorView, behavior: String) in
        view.setEnterBehavior(behavior)
      }
      Prop("textPasteThresholdBytes") { (view: StarkComposerEditorView, threshold: Int) in
        view.setTextPasteThresholdBytes(threshold)
      }
      Prop("maxInputChars") { (view: StarkComposerEditorView, maxInputChars: Int) in
        view.setMaxInputChars(maxInputChars)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContextPress",
        "onComposerPasteContext",
        "onComposerPasteText",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: StarkComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: StarkComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: StarkComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
