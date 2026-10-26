#import "StarkSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "StarkSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/StarkSourceTextSpec/Props.h>
#import <react/renderer/components/StarkSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface StarkSourceTextRun () <RCTStarkSourceTextRunViewProtocol>

@end

@implementation StarkSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      StarkSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const StarkSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<StarkSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<StarkSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> StarkSourceTextRunCls(void) {
  return StarkSourceTextRun.class;
}

@end
