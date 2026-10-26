Pod::Spec.new do |s|
  s.name           = 'StarkComposerEditor'
  s.version        = '1.0.0'
  s.summary        = 'Native attributed composer editor for Stark Code mobile.'
  s.description    = 'UIKit-backed rich text composer with atomic skill and file tokens.'
  s.author         = 'Stark Future'
  s.homepage       = 'https://starkfuture.com'
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
