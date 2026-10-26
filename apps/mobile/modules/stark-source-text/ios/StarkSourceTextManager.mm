#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface StarkSourceTextManager : RCTViewManager
@end

@implementation StarkSourceTextManager

RCT_EXPORT_MODULE(StarkSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface StarkSourceTextRunManager : RCTViewManager
@end

@implementation StarkSourceTextRunManager

RCT_EXPORT_MODULE(StarkSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
