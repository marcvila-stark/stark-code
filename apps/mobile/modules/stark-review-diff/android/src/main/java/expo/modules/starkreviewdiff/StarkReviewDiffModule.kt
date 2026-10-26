package expo.modules.starkreviewdiff

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class StarkReviewDiffModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarkReviewDiffSurface")

    View(StarkReviewDiffView::class) {
      Prop("tokensResetKey") { view: StarkReviewDiffView, tokensResetKey: String ->
        view.setTokensResetKey(tokensResetKey)
      }
      Prop("contentResetKey") { view: StarkReviewDiffView, contentResetKey: String ->
        view.setContentResetKey(contentResetKey)
      }
      Prop("collapsedFileIdsJson") { view: StarkReviewDiffView, collapsedFileIdsJson: String ->
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }
      Prop("viewedFileIdsJson") { view: StarkReviewDiffView, viewedFileIdsJson: String ->
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }
      Prop("selectedRowIdsJson") { view: StarkReviewDiffView, selectedRowIdsJson: String ->
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }
      Prop("collapsedCommentIdsJson") { view: StarkReviewDiffView, collapsedCommentIdsJson: String ->
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }
      Prop("appearanceScheme") { view: StarkReviewDiffView, appearanceScheme: String ->
        view.setAppearanceScheme(appearanceScheme)
      }
      Prop("themeJson") { view: StarkReviewDiffView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("styleJson") { view: StarkReviewDiffView, styleJson: String ->
        view.setStyleJson(styleJson)
      }
      Prop("rowHeight") { view: StarkReviewDiffView, rowHeight: Double ->
        view.setRowHeight(rowHeight.toFloat())
      }
      Prop("contentWidth") { view: StarkReviewDiffView, contentWidth: Double ->
        view.setContentWidth(contentWidth.toFloat())
      }
      Prop("contentInsetBottom") { view: StarkReviewDiffView, value: Double ->
        view.setContentInsetBottom(value.toFloat())
      }
      Prop("scrollEnabled") { view: StarkReviewDiffView, enabled: Boolean ->
        view.setScrollEnabled(enabled)
      }
      Prop("initialRowIndex") { view: StarkReviewDiffView, initialRowIndex: Double ->
        view.setInitialRowIndex(initialRowIndex)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
      )

      AsyncFunction("scrollToFile") { view: StarkReviewDiffView, fileId: String, animated: Boolean ->
        view.scrollToFile(fileId, animated)
      }
      AsyncFunction("scrollToTop") { view: StarkReviewDiffView, animated: Boolean ->
        view.scrollToTop(animated)
      }
      AsyncFunction("setRowsJson") { view: StarkReviewDiffView, rowsJson: String ->
        view.setRowsJson(rowsJson)
      }
      AsyncFunction("setTokensJson") { view: StarkReviewDiffView, tokensJson: String ->
        view.setTokensJson(tokensJson)
      }
      AsyncFunction("setTokensPatchJson") { view: StarkReviewDiffView, tokensPatchJson: String ->
        view.setTokensPatchJson(tokensPatchJson)
      }

      OnViewDestroys { view: StarkReviewDiffView ->
        view.cleanup()
      }
    }
  }
}
