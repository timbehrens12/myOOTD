require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ClothingIsolator'
  s.version        = package['version']
  s.summary        = package['description']
  s.homepage       = 'https://github.com/myootd/myootd-mobile'
  s.license        = { :type => 'MIT' }
  s.authors        = 'myootd'
  s.platform       = :ios, '13.0'
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files   = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks     = ['Vision', 'CoreImage', 'CoreML', 'UIKit']

  # SAM 2.1 CoreML models live in ios/Models/*.mlpackage. They are NOT committed
  # to git (each is ~150–450 MB); download with:
  #   huggingface-cli download apple/coreml-sam2.1-small \
  #     --local-dir modules/clothing-isolator/ios/Models
  # CocoaPods compiles every .mlpackage into a .mlmodelc inside the app's
  # main bundle at build time, which SAM2Segmenter loads at runtime.
  s.resources      = 'ios/Models/**/*.mlpackage'
end
