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
  s.frameworks     = ['Vision', 'CoreImage', 'UIKit']
end
