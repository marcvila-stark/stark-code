package expo.modules.starkterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class StarkTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarkTerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants(
      "hardwareKeyRevision" to 2,
    )

    View(StarkTerminalView::class) {
      Prop("terminalKey") { view: StarkTerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: StarkTerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: StarkTerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: StarkTerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("readOnly") { view: StarkTerminalView, readOnly: Boolean ->
        view.readOnly = readOnly
      }

      Prop("autoFocus") { view: StarkTerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: StarkTerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: StarkTerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: StarkTerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: StarkTerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: StarkTerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Prop("captureRequest") { view: StarkTerminalView, request: Double ->
        view.captureRequest = request
      }
      Events("onInput", "onResize", "onCapture")

      OnViewDestroys { view: StarkTerminalView ->
        view.cleanup()
      }
    }
  }
}
