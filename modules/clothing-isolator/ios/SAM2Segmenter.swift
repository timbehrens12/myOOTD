import CoreML
import CoreImage
import CoreGraphics
import UIKit

// ──────────────────────────────────────────────────────────────────────────────
// SAM2Segmenter
//
// On-device SAM 2.1 (Apple CoreML port) garment segmentation. Chains three
// CoreML models — image encoder, prompt encoder, mask decoder — to produce a
// binary garment mask at the input patch resolution.
//
// Why runtime MLModel API (not auto-generated wrappers):
//   Xcode auto-generates Swift wrappers for `.mlpackage` files when they are
//   added to a normal app target. That codegen step does not happen reliably
//   for files included via a CocoaPods `s.resources` manifest — which is how
//   this Expo native module pulls in the models. Using `MLDictionaryFeatureProvider`
//   + `MLModel(contentsOf:)` bypasses the codegen entirely so the pod compiles
//   whether or not the `.mlpackage`s happen to be registered with the app target.
//
// Required bundle resources (downloaded via `huggingface-cli`; see README):
//   SAM2_1{Variant}ImageEncoderFLOAT16.mlmodelc
//   SAM2_1{Variant}PromptEncoderFLOAT16.mlmodelc
//   SAM2_1{Variant}MaskDecoderFLOAT16.mlmodelc
// where {Variant} ∈ {Tiny, Small, Large}. CocoaPods compiles .mlpackage → .mlmodelc
// during the app build, so only `.mlpackage` needs to live in `ios/Models/`.
// ──────────────────────────────────────────────────────────────────────────────

public enum SAM2Error: Error {
  case modelsNotAvailable
  case pixelBufferCreationFailed
  case inferenceFailed(String)
  case invalidOutput(String)
}

public struct SAM2Result {
  /// Grayscale 8-bit CGImage at the original patch resolution. 255 = foreground.
  public let mask: CGImage
  /// SAM 2 IoU prediction score for the chosen mask (0…1). We use it as a
  /// confidence gate — anything below `SAM2Configuration.confidenceThreshold`
  /// falls back to the Vision path.
  public let confidence: Float
  /// Low-res logits min/max — useful for debugging / alt thresholds.
  public let logitsMin: Float
  public let logitsMax: Float
}

public struct SAM2Configuration {
  public enum Variant: String {
    case tiny = "Tiny"
    case small = "Small"
    case large = "Large"
  }
  public var variant: Variant
  public var confidenceThreshold: Float
  /// When false, SAM2Segmenter short-circuits to return nil (lets the caller
  /// force-use the Vision pipeline, handy for A/B debugging).
  public var enabled: Bool

  public init(
    variant: Variant = .small,
    confidenceThreshold: Float = 0.85,
    enabled: Bool = true
  ) {
    self.variant = variant
    self.confidenceThreshold = confidenceThreshold
    self.enabled = enabled
  }

  public static let `default` = SAM2Configuration()

  var modelFileNames: (encoder: String, prompt: String, decoder: String) {
    let v = variant.rawValue
    return (
      "SAM2_1\(v)ImageEncoderFLOAT16",
      "SAM2_1\(v)PromptEncoderFLOAT16",
      "SAM2_1\(v)MaskDecoderFLOAT16"
    )
  }
}

/// Singleton-style lazy loader keyed by variant. First call blocks while models
/// load (~0.5–2s cold on iPhone 15 Pro); subsequent calls are ~free.
final class SAM2ModelBundle {
  static let shared = SAM2ModelBundle()
  private let lock = NSLock()
  private var loadedVariant: SAM2Configuration.Variant?
  private var imageEncoder: MLModel?
  private var promptEncoder: MLModel?
  private var maskDecoder: MLModel?
  private var lastError: Error?

  /// Last error encountered during load (nil if load succeeded or never ran).
  /// Callers use this for telemetry — the load path itself just returns nil on failure.
  var loadError: Error? { lock.lock(); defer { lock.unlock() }; return lastError }

  func models(for config: SAM2Configuration) -> (MLModel, MLModel, MLModel)? {
    lock.lock()
    defer { lock.unlock() }

    if loadedVariant == config.variant,
       let ie = imageEncoder, let pe = promptEncoder, let md = maskDecoder {
      return (ie, pe, md)
    }

    // Variant changed or first load — (re)load. Clear previous handles.
    imageEncoder = nil
    promptEncoder = nil
    maskDecoder = nil
    loadedVariant = nil
    lastError = nil

    let mlConfig = MLModelConfiguration()
    // `.all` lets CoreML pick CPU + GPU + Neural Engine as appropriate; it's
    // been available since iOS 13 (the pod's deployment target), so no guards
    // needed. `.cpuAndNeuralEngine` is iOS 16+ and we don't need to force it.
    mlConfig.computeUnits = .all

    do {
      let names = config.modelFileNames
      imageEncoder = try loadCompiledModel(named: names.encoder, config: mlConfig)
      promptEncoder = try loadCompiledModel(named: names.prompt, config: mlConfig)
      maskDecoder = try loadCompiledModel(named: names.decoder, config: mlConfig)
      loadedVariant = config.variant
      NSLog("[SAM2] loaded \(config.variant.rawValue) models")
      return (imageEncoder!, promptEncoder!, maskDecoder!)
    } catch {
      lastError = error
      imageEncoder = nil
      promptEncoder = nil
      maskDecoder = nil
      loadedVariant = nil
      NSLog("[SAM2] model load failed: \(error.localizedDescription)")
      return nil
    }
  }

  private func loadCompiledModel(named name: String, config: MLModelConfiguration) throws -> MLModel {
    // Prefer .mlmodelc (compiled at app build time) but fall back to raw .mlpackage
    // (CocoaPods `s.resources` copies .mlpackage directories verbatim without
    // running the CoreML compiler, so we compile at runtime and cache the result).
    let bundles = [Bundle.main, Bundle(for: SAM2ModelBundle.self)]
    NSLog("[SAM2] loadCompiledModel: searching for '\(name)'")

    // Pass 1: prefer already-compiled .mlmodelc.
    for bundle in bundles {
      if let url = bundle.url(forResource: name, withExtension: "mlmodelc") {
        NSLog("[SAM2]   ✓ found .mlmodelc at \(url.path), loading directly")
        return try MLModel(contentsOf: url, configuration: config)
      }
    }

    // Pass 2: compile .mlpackage at runtime, cache the result under Caches/SAM2/.
    for bundle in bundles {
      guard let pkgURL = bundle.url(forResource: name, withExtension: "mlpackage") else {
        continue
      }
      NSLog("[SAM2]   found .mlpackage at \(pkgURL.path) — will compile if needed")
      let cachedURL = try cachedCompiledURL(for: name, sourcePkg: pkgURL)
      NSLog("[SAM2]   loading compiled model from \(cachedURL.path)")
      return try MLModel(contentsOf: cachedURL, configuration: config)
    }

    NSLog("[SAM2] modelsNotAvailable: '\(name)' not found in any bundle")
    throw SAM2Error.modelsNotAvailable
  }

  /// Returns a URL to a compiled `.mlmodelc` for `name`. If the cache is empty
  /// or stale (source package mtime newer than cached mtime), recompiles.
  private func cachedCompiledURL(for name: String, sourcePkg: URL) throws -> URL {
    let fm = FileManager.default
    let cacheRoot = try fm
      .url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("SAM2Models", isDirectory: true)
    try fm.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    let dest = cacheRoot.appendingPathComponent("\(name).mlmodelc", isDirectory: true)

    // Invalidate cache if source mtime is newer than cached mtime.
    if fm.fileExists(atPath: dest.path) {
      let srcAttrs = try? fm.attributesOfItem(atPath: sourcePkg.path)
      let dstAttrs = try? fm.attributesOfItem(atPath: dest.path)
      let srcMtime = (srcAttrs?[.modificationDate] as? Date) ?? Date.distantPast
      let dstMtime = (dstAttrs?[.modificationDate] as? Date) ?? Date.distantPast
      if dstMtime >= srcMtime {
        NSLog("[SAM2]   cache hit: \(dest.lastPathComponent)")
        return dest
      }
      NSLog("[SAM2]   cache stale, recompiling")
      try? fm.removeItem(at: dest)
    }

    NSLog("[SAM2]   compiling \(sourcePkg.lastPathComponent) → cache (first launch only)")
    let t0 = Date()
    let compiledTmp = try MLModel.compileModel(at: sourcePkg)
    let compileMs = Int(Date().timeIntervalSince(t0) * 1000)
    NSLog("[SAM2]   compiled in \(compileMs)ms → \(compiledTmp.path)")

    // compileModel writes to a temporary location; move to stable cache path.
    if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: dest) }
    try fm.moveItem(at: compiledTmp, to: dest)
    return dest
  }
}

public final class SAM2Segmenter {
  public static let inputSide: Int = 1024

  public var configuration: SAM2Configuration

  public init(configuration: SAM2Configuration = .default) {
    self.configuration = configuration
  }

  /// Returns a dict describing bundle search results for JS-side debugging.
  /// Useful when NSLog isn't accessible (e.g., Windows dev without Xcode).
  public static func bundleDiagnostics(variant: SAM2Configuration.Variant = .small) -> [String: Any] {
    let names = SAM2Configuration(variant: variant).modelFileNames
    let bundles: [(String, Bundle)] = [
      ("main", Bundle.main),
      ("pod", Bundle(for: SAM2ModelBundle.self)),
    ]
    var result: [String: Any] = ["variant": variant.rawValue, "encoderName": names.encoder]
    for (tag, bundle) in bundles {
      var b: [String: Any] = [
        "identifier": bundle.bundleIdentifier ?? "nil",
        "path": bundle.bundlePath,
      ]
      b["encoder_mlmodelc"] = bundle.url(forResource: names.encoder, withExtension: "mlmodelc")?.path ?? "nil"
      b["encoder_mlpackage"] = bundle.url(forResource: names.encoder, withExtension: "mlpackage")?.path ?? "nil"
      b["prompt_mlmodelc"] = bundle.url(forResource: names.prompt, withExtension: "mlmodelc")?.path ?? "nil"
      b["decoder_mlmodelc"] = bundle.url(forResource: names.decoder, withExtension: "mlmodelc")?.path ?? "nil"
      let allMlmodelc = bundle.paths(forResourcesOfType: "mlmodelc", inDirectory: nil)
      let allMlpackage = bundle.paths(forResourcesOfType: "mlpackage", inDirectory: nil)
      b["allMlmodelcInBundle"] = allMlmodelc.map { ($0 as NSString).lastPathComponent }.joined(separator: ",")
      b["allMlpackageInBundle"] = allMlpackage.map { ($0 as NSString).lastPathComponent }.joined(separator: ",")
      result[tag] = b
    }
    return result
  }

  /// Cheap check — does not force a model load.
  public static func modelsPresentOnDisk(variant: SAM2Configuration.Variant = .small) -> Bool {
    let names = SAM2Configuration(variant: variant).modelFileNames
    let bundles = [Bundle.main, Bundle(for: SAM2ModelBundle.self)]
    NSLog("[SAM2] modelsPresentOnDisk: checking for \(variant.rawValue)")
    for (bundleIdx, bundle) in bundles.enumerated() {
      let bundleDesc = bundleIdx == 0 ? "main" : "ClothingIsolator pod"
      let mlmodelc = bundle.url(forResource: names.encoder, withExtension: "mlmodelc")
      let mlpackage = bundle.url(forResource: names.encoder, withExtension: "mlpackage")
      NSLog("[SAM2]   bundle[\(bundleIdx)] (\(bundleDesc)): mlmodelc=\(mlmodelc != nil), mlpackage=\(mlpackage != nil)")
      if mlmodelc != nil || mlpackage != nil {
        NSLog("[SAM2]   ✓ models present")
        return true
      }
    }
    NSLog("[SAM2]   ✗ models NOT found in any bundle")
    return false
  }

  /// Generate a per-pixel garment mask for `patch` using a box prompt.
  ///
  /// - Parameters:
  ///   - patch: pre-cropped garment region. The whole image is fed to the SAM 2
  ///     image encoder (stretched to 1024×1024), so passing a tight patch gives
  ///     the encoder the highest effective resolution on the garment.
  ///   - box: box prompt in **patch pixel coordinates** (origin top-left, y-down).
  ///     If nil, the full patch extent is used as the prompt (equivalent to saying
  ///     "the garment fills this image").
  /// - Returns: Mask + confidence, or nil if SAM 2 is disabled / models missing /
  ///   confidence below threshold. On failure callers should use the existing
  ///   Vision fallback rather than surfacing the error.
  public func generateMask(for patch: CGImage, box: CGRect? = nil) -> SAM2Result? {
    guard configuration.enabled else { return nil }
    guard let (encoder, prompter, decoder) = SAM2ModelBundle.shared.models(for: configuration) else {
      return nil
    }

    do {
      let side = SAM2Segmenter.inputSide
      let patchW = CGFloat(patch.width)
      let patchH = CGFloat(patch.height)

      // 1) Resize patch → 1024×1024 BGRA pixel buffer.
      //    We intentionally stretch (not letterbox): SAM 2's positional encoding
      //    learned on the full 1024 canvas, and black letterbox bars distort it.
      guard let resizedPB = makeResizedPixelBuffer(patch: patch, toSide: side) else {
        throw SAM2Error.pixelBufferCreationFailed
      }

      // 2) Image encoder.
      let imgInputName = firstInputName(of: encoder) ?? "image"
      let imgInput = try MLDictionaryFeatureProvider(dictionary: [
        imgInputName: MLFeatureValue(pixelBuffer: resizedPB),
      ])
      let imgOut = try encoder.prediction(from: imgInput)
      guard let imageEmbedding = imgOut.featureValue(for: "image_embedding")?.multiArrayValue,
            let featsS0 = imgOut.featureValue(for: "feats_s0")?.multiArrayValue,
            let featsS1 = imgOut.featureValue(for: "feats_s1")?.multiArrayValue
      else { throw SAM2Error.invalidOutput("image_encoder") }

      // 3) Prompt encoder. Box prompt = 2 points, labels {2: boxOrigin, 3: boxEnd}
      //    (matching sam2-studio's SAMCategoryType enum).
      let promptBox = box ?? CGRect(x: 0, y: 0, width: patchW, height: patchH)
      let sx = CGFloat(side) / patchW
      let sy = CGFloat(side) / patchH
      let tl = CGPoint(x: promptBox.minX * sx, y: promptBox.minY * sy)
      let br = CGPoint(x: promptBox.maxX * sx, y: promptBox.maxY * sy)

      let points = try MLMultiArray(shape: [1, 2, 2], dataType: .float32)
      points[[0, 0, 0] as [NSNumber]] = NSNumber(value: Float(tl.x))
      points[[0, 0, 1] as [NSNumber]] = NSNumber(value: Float(tl.y))
      points[[0, 1, 0] as [NSNumber]] = NSNumber(value: Float(br.x))
      points[[0, 1, 1] as [NSNumber]] = NSNumber(value: Float(br.y))

      let labels = try MLMultiArray(shape: [1, 2], dataType: .int32)
      labels[[0, 0] as [NSNumber]] = NSNumber(value: 2)
      labels[[0, 1] as [NSNumber]] = NSNumber(value: 3)

      let promptInput = try MLDictionaryFeatureProvider(dictionary: [
        "points": MLFeatureValue(multiArray: points),
        "labels": MLFeatureValue(multiArray: labels),
      ])
      let promptOut = try prompter.prediction(from: promptInput)
      guard let sparseEmb = promptOut.featureValue(for: "sparse_embeddings")?.multiArrayValue,
            let denseEmb = promptOut.featureValue(for: "dense_embeddings")?.multiArrayValue
      else { throw SAM2Error.invalidOutput("prompt_encoder") }

      // 4) Mask decoder.
      let decoderInput = try MLDictionaryFeatureProvider(dictionary: [
        "image_embedding": MLFeatureValue(multiArray: imageEmbedding),
        "sparse_embedding": MLFeatureValue(multiArray: sparseEmb),
        "dense_embedding": MLFeatureValue(multiArray: denseEmb),
        "feats_s0": MLFeatureValue(multiArray: featsS0),
        "feats_s1": MLFeatureValue(multiArray: featsS1),
      ])
      let decoderOut = try decoder.prediction(from: decoderInput)
      guard let scoresMA = decoderOut.featureValue(for: "scores")?.multiArrayValue,
            let masksMA = decoderOut.featureValue(for: "low_res_masks")?.multiArrayValue
      else { throw SAM2Error.invalidOutput("mask_decoder") }

      // Pick the mask with the highest IoU score.
      var bestIdx = 0
      var bestScore: Float = -Float.greatestFiniteMagnitude
      for i in 0..<scoresMA.count {
        let s = scoresMA[i].floatValue
        if s > bestScore { bestScore = s; bestIdx = i }
      }

      guard bestScore >= configuration.confidenceThreshold else {
        NSLog("[SAM2] confidence \(bestScore) below threshold \(configuration.confidenceThreshold), falling back")
        return nil
      }

      guard let maskData = decodeMaskPlane(masks: masksMA, instanceIndex: bestIdx) else {
        throw SAM2Error.invalidOutput("mask_plane")
      }
      guard let lowResCG = grayscaleCGImage(bytes: maskData.bytes, width: maskData.width, height: maskData.height) else {
        throw SAM2Error.invalidOutput("mask_cgimage")
      }
      let resizedCG = resizeGrayscaleCGImage(
        lowResCG,
        to: CGSize(width: patch.width, height: patch.height)
      ) ?? lowResCG

      return SAM2Result(
        mask: resizedCG,
        confidence: bestScore,
        logitsMin: maskData.minLogit,
        logitsMax: maskData.maxLogit
      )
    } catch {
      NSLog("[SAM2] inference failed: \(error.localizedDescription)")
      return nil
    }
  }

  // MARK: - Private helpers

  private func firstInputName(of model: MLModel) -> String? {
    return model.modelDescription.inputDescriptionsByName.keys.first
  }

  /// Create a square BGRA CVPixelBuffer of `side`×`side` with `patch` drawn in (stretched).
  private func makeResizedPixelBuffer(patch: CGImage, toSide side: Int) -> CVPixelBuffer? {
    let attrs: [CFString: Any] = [
      kCVPixelBufferCGImageCompatibilityKey: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey: true,
    ]
    var pb: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      side, side,
      kCVPixelFormatType_32BGRA,
      attrs as CFDictionary,
      &pb
    )
    guard status == kCVReturnSuccess, let buffer = pb else { return nil }

    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
      data: base,
      width: side,
      height: side,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: cs,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return nil }

    ctx.interpolationQuality = .high
    ctx.draw(patch, in: CGRect(x: 0, y: 0, width: side, height: side))
    return buffer
  }

  private struct MaskPlane {
    let bytes: [UInt8]   // row-major, 0 or 255
    let width: Int
    let height: Int
    let minLogit: Float
    let maxLogit: Float
  }

  /// Extract plane `[0, instanceIndex, :, :]` from `low_res_masks` and threshold
  /// at the zero-crossing of the logits (standard SAM 2 convention — min-max
  /// normalize, then the zero-crossing threshold is `-min / (max - min)`).
  private func decodeMaskPlane(masks: MLMultiArray, instanceIndex: Int) -> MaskPlane? {
    let shape = masks.shape.map { $0.intValue }
    // Expected shape: [1, 3, H, W]. Tolerate [3, H, W] in case a future model drops batch.
    let h: Int
    let w: Int
    let gather: (Int, Int) -> Float
    if shape.count == 4, instanceIndex >= 0, instanceIndex < shape[1] {
      h = shape[2]; w = shape[3]
      gather = { y, x in
        masks[[0, instanceIndex, y, x] as [NSNumber]].floatValue
      }
    } else if shape.count == 3, instanceIndex >= 0, instanceIndex < shape[0] {
      h = shape[1]; w = shape[2]
      gather = { y, x in
        masks[[instanceIndex, y, x] as [NSNumber]].floatValue
      }
    } else {
      return nil
    }

    var minV = Float.greatestFiniteMagnitude
    var maxV = -Float.greatestFiniteMagnitude
    var raw = [Float](repeating: 0, count: h * w)
    for y in 0..<h {
      let rowStart = y * w
      for x in 0..<w {
        let v = gather(y, x)
        raw[rowStart + x] = v
        if v < minV { minV = v }
        if v > maxV { maxV = v }
      }
    }

    // Threshold at zero (binary mask). SAM 2 logits: positive = foreground.
    var bytes = [UInt8](repeating: 0, count: h * w)
    for i in 0..<(h * w) {
      bytes[i] = raw[i] > 0 ? 255 : 0
    }

    return MaskPlane(bytes: bytes, width: w, height: h, minLogit: minV, maxLogit: maxV)
  }

  private func grayscaleCGImage(bytes: [UInt8], width: Int, height: Int) -> CGImage? {
    guard width > 0, height > 0, bytes.count == width * height else { return nil }
    var mutable = bytes
    return mutable.withUnsafeMutableBufferPointer { ptr -> CGImage? in
      guard let base = ptr.baseAddress else { return nil }
      let cs = CGColorSpaceCreateDeviceGray()
      guard let ctx = CGContext(
        data: base,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
      ) else { return nil }
      return ctx.makeImage()
    }
  }

  private func resizeGrayscaleCGImage(_ cg: CGImage, to size: CGSize) -> CGImage? {
    let w = Int(size.width)
    let h = Int(size.height)
    guard w > 0, h > 0 else { return nil }
    let cs = CGColorSpaceCreateDeviceGray()
    guard let ctx = CGContext(
      data: nil,
      width: w,
      height: h,
      bitsPerComponent: 8,
      bytesPerRow: w,
      space: cs,
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
  }
}
