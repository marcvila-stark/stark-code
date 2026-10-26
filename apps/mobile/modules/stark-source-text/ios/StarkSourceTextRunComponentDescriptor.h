#pragma once

#include "StarkSourceTextRunShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using StarkSourceTextRunComponentDescriptor =
    ConcreteComponentDescriptor<StarkSourceTextRunShadowNode>;

void StarkSourceTextRunSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
