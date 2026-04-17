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
    // Prefer .mlmodelc (compiled at app build time) but allow raw .mlpackage too
    // (e.g., if someone did an ad-hoc Xcode drag-drop in dev). Search both the
    // main bundle and this module's bundle.
    let candidates: [(String, String)] = [
      (name, "mlmodelc"),
      (name, "mlpackage"),
    ]
    let bundles = [Bundle.main, Bundle(for: SAM2ModelBundle.self)]
    for bundle in bundles {
      for (res, ext) in candidates {
        if let url = bundle.url(forResource: res, withExtension: ext) {
          return try MLModel(contentsOf: url, configuration: config)
        }
      }
    }
    throw SAM2Error.modelsNotAvailable
  }
}

public final class SAM2Segmenter {
  public static let inputSide: Int = 1024

  public var configuration: SAM2Configuration

  public init(configuration: SAM2Configuration = .default) {
    self.configuration = configuration
  }

  /// Cheap check — does not force a model load.
  public static func modelsPresentOnDisk(variant: SAM2Configuration.Variant = .small) -> Bool {
    let names = SAM2Configuration(variant: variant).modelFileNames
    let bundles = [Bundle.main, Bundle(for: SAM2ModelBundle.self)]
    for bundle in bundles {
      if bundle.url(forResource: names.encoder, withExtension: "mlmodelc") != nil ||
         bundle.url(forResource: names.encoder, withExtension: "mlpackage") != nil {
        return true
      }
    }
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
