#pragma once

#include <react/renderer/components/StarkSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/StarkSourceTextSpec/Props.h>
#include <react/renderer/components/StarkSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char StarkSourceTextRunComponentName[];

using StarkSourceTextRunShadowNode =
    ConcreteViewShadowNode<StarkSourceTextRunComponentName, StarkSourceTextRunProps,
                           StarkSourceTextRunEventEmitter, StarkSourceTextRunState>;
} // namespace facebook::react
