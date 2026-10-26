import ExpoModulesCore

public class StarkTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StarkTerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants([
      "hardwareKeyRevision": 3,
    ])

    View(StarkTerminalView.self) {
      Prop("terminalKey") { (view: StarkTerminalView, terminalKey: String) in
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { (view: StarkTerminalView, initialBuffer: String) in
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { (view: StarkTerminalView, fontSize: Double) in
        view.fontSize = CGFloat(fontSize)
      }

      Prop("focusRequest") { (view: StarkTerminalView, focusRequest: Double) in
        view.focusRequest = focusRequest
      }

      Prop("readOnly") { (view: StarkTerminalView, readOnly: Bool) in
        view.readOnly = readOnly
      }

      Prop("autoFocus") { (view: StarkTerminalView, autoFocus: Bool) in
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { (view: StarkTerminalView, appearanceScheme: String) in
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { (view: StarkTerminalView, themeConfig: String) in
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { (view: StarkTerminalView, backgroundColor: String) in
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { (view: StarkTerminalView, foregroundColor: String) in
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { (view: StarkTerminalView, mutedForegroundColor: String) in
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Prop("captureRequest") { (view: StarkTerminalView, request: Double) in
        view.captureRequest = request
      }
      Events("onInput", "onResize", "onCapture")
    }
  }
}
