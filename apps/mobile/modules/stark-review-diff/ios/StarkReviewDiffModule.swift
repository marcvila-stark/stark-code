import ExpoModulesCore

public class StarkReviewDiffModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StarkReviewDiffSurface")

    View(StarkReviewDiffView.self) {
      Prop("contentInsetTop") { (view: StarkReviewDiffView, value: Double) in
        view.setContentInsetTop(CGFloat(value))
      }

      Prop("contentInsetBottom") { (view: StarkReviewDiffView, value: Double) in
        view.setContentInsetBottom(CGFloat(value))
      }

      Prop("tokensResetKey") { (view: StarkReviewDiffView, tokensResetKey: String) in
        view.setTokensResetKey(tokensResetKey)
      }

      Prop("contentResetKey") { (view: StarkReviewDiffView, contentResetKey: String) in
        view.setContentResetKey(contentResetKey)
      }

      Prop("collapsedFileIdsJson") { (view: StarkReviewDiffView, collapsedFileIdsJson: String) in
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }

      Prop("viewedFileIdsJson") { (view: StarkReviewDiffView, viewedFileIdsJson: String) in
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }

      Prop("selectedRowIdsJson") { (view: StarkReviewDiffView, selectedRowIdsJson: String) in
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }

      Prop("collapsedCommentIdsJson") { (view: StarkReviewDiffView, collapsedCommentIdsJson: String) in
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }

      Prop("appearanceScheme") { (view: StarkReviewDiffView, appearanceScheme: String) in
        view.setAppearanceScheme(appearanceScheme)
      }

      Prop("themeJson") { (view: StarkReviewDiffView, themeJson: String) in
        view.setThemeJson(themeJson)
      }

      Prop("styleJson") { (view: StarkReviewDiffView, styleJson: String) in
        view.setStyleJson(styleJson)
      }

      Prop("rowHeight") { (view: StarkReviewDiffView, rowHeight: Double) in
        view.setRowHeight(CGFloat(rowHeight))
      }

      Prop("contentWidth") { (view: StarkReviewDiffView, contentWidth: Double) in
        view.setContentWidth(CGFloat(contentWidth))
      }

      Prop("initialRowIndex") { (view: StarkReviewDiffView, initialRowIndex: Double) in
        view.setInitialRowIndex(initialRowIndex)
      }

      Prop("scrollEnabled") { (view: StarkReviewDiffView, enabled: Bool) in
        view.setScrollEnabled(enabled)
      }

      Prop("bounces") { (view: StarkReviewDiffView, bounces: Bool) in
        view.setBounces(bounces)
      }

      Prop("refreshEnabled") { (view: StarkReviewDiffView, enabled: Bool) in
        view.setRefreshEnabled(enabled)
      }

      Prop("refreshing") { (view: StarkReviewDiffView, refreshing: Bool) in
        view.setRefreshing(refreshing)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
        "onPullToRefresh"
      )

      AsyncFunction("scrollToFile") { (view: StarkReviewDiffView, fileId: String, animated: Bool) in
        view.scrollToFile(fileId, animated: animated)
      }

      AsyncFunction("scrollToTop") { (view: StarkReviewDiffView, animated: Bool) in
        view.scrollToTop(animated: animated)
      }

      // Large, frequently changing JSON values cannot be regular Fabric props. Expo's
      // prop adapter compares strings on the main thread before invoking a setter, which
      // makes a syntax-token patch capable of blocking a frame by itself.
      AsyncFunction("setRowsJson") { (view: StarkReviewDiffView, rowsJson: String) in
        view.setRowsJson(rowsJson)
      }

      AsyncFunction("setTokensJson") { (view: StarkReviewDiffView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }

      AsyncFunction("setTokensPatchJson") { (view: StarkReviewDiffView, tokensPatchJson: String) in
        view.setTokensPatchJson(tokensPatchJson)
      }
    }
  }
}
