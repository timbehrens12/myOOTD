import ExpoModulesCore
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit
import Vision

/// Output size for square PNG cutouts (cover fit: item fills as much of the square as possible).
private let kCutoutSquareSide: CGFloat = 1024

// ──────────────────────────────────────────────────────────────────────────────
// ClothingIsolatorModule
//
// segmentItems(base64Jpeg)
//   iOS 17+: VNGenerateForegroundInstanceMaskRequest → one square PNG per instance,
//            transparent background, garment cover-fitted into kCutoutSquareSide.
//   iOS <17: returns [] → JS falls back to cloud pipeline.
//
// cropGarments(maskedBase64, boxes)
//   Crops each box from masked image + padding → transparent PNG when source has alpha;
//   otherwise legacy white-bg JPEG.
//   Used for fit-check photos where Vision sees one person but the classifier
//   returns per-garment bounding boxes.
// ──────────────────────────────────────────────────────────────────────────────

public class ClothingIsolatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClothingIsolator")

    AsyncFunction("segmentItems") { (base64Jpeg: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let results = try self.performSegmentation(base64: base64Jpeg)
          promise.resolve(results)
        } catch {
          promise.reject("SEGMENTATION_FAILED", error.localizedDescription)
        }
      }
    }

    // boxes: [[ymin, xmin, ymax, xmax], ...] in 0–1000 coords
    AsyncFunction("cropGarments") { (maskedBase64: String, boxes: [[Double]], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let results = self.cropGarmentsFromMasked(maskedBase64: maskedBase64, boxes: boxes)
        promise.resolve(results)
      }
    }

    /// Masked crop per box; if crop is mostly empty (white), same rect from original JPEG.
    AsyncFunction("cropGarmentsWithFallback") { (maskedBase64: String, originalBase64: String, boxes: [[Double]], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let results = self.cropGarmentsWithOriginalFallback(maskedBase64: maskedBase64, originalBase64: originalBase64, boxes: boxes)
        promise.resolve(results)
      }
    }

    /// Run Vision on the original image, then crop each box from a full-frame mask aligned
    /// to the original's coordinate system. Guarantees per-item background removal with no
    /// scale/offset drift. iOS 17+ only. Falls back to plain original crop on pre-17 / errors.
    AsyncFunction("cropGarmentsFromOriginal") { (originalBase64: String, boxes: [[Double]], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let results = self.cropGarmentsFromOriginalFreshMask(originalBase64: originalBase64, boxes: boxes)
        promise.resolve(results)
      }
    }

    /// Local Core Image polish (sharpen + mild color) — no network.
    /// Returns a file:// URL so huge JPEGs are not passed through the JS bridge as base64.
    AsyncFunction("polishCutout") { (jpegBase64: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        if let out = self.polishJpegToTempFileUrl(plainBase64: jpegBase64) {
          promise.resolve(out)
        } else {
          promise.reject("POLISH_FAILED", "Could not decode JPEG or run Core Image polish")
        }
      }
    }

    /// Same as polishCutout but reads from `file://` in native code (avoids huge base64 over the bridge).
    AsyncFunction("polishCutoutUri") { (fileUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        if let out = self.polishFileUriToTempFileUrl(fileUri) {
          promise.resolve(out)
        } else {
          promise.reject("POLISH_FAILED", "Could not read file or run Core Image polish")
        }
      }
    }

    /// Aesty-style one-shot Enhance. Returns { uri, debug }.
    /// `box2d` is optional [ymin, xmin, ymax, xmax] in 0–1000 coords. When provided,
    /// the original is pre-cropped to that region (with 8% context padding) BEFORE
    /// Vision segmentation — this is critical for fit-check photos so Vision isolates
    /// the GARMENT inside that region, not the whole person.
    AsyncFunction("enhanceItem") { (input: String, box2d: [Double], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let result = self.enhanceItemFromInput(input, box2d: box2d)
        promise.resolve(result)
      }
    }
  }

  // ── Aesty-style on-device Enhance ─────────────────────────────────────────

  private func loadUIImage(fromInput input: String) -> UIImage? {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if let url = URL(string: trimmed), url.isFileURL,
       let data = try? Data(contentsOf: url) {
      return UIImage(data: data)
    }
    var payload = trimmed
      .replacingOccurrences(of: "\n", with: "")
      .replacingOccurrences(of: "\r", with: "")
    if let r = payload.range(of: "base64,", options: .caseInsensitive) {
      payload = String(payload[r.upperBound...])
    }
    if let data = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters]) {
      return UIImage(data: data)
    }
    return nil
  }

  private func enhanceItemFromInput(_ input: String, box2d: [Double]) -> [String: Any] {
    var debug: [String: Any] = [:]
    guard let ui = loadUIImage(fromInput: input) else {
      debug["error"] = "could not decode input image"
      return ["uri": "", "debug": debug]
    }
    guard let fullCg = normalizedCGImage(from: ui) else {
      debug["error"] = "could not normalize CGImage"
      return ["uri": "", "debug": debug]
    }

    // If a box2d was provided, pre-crop the original to that garment region with
    // a little context padding so Vision can find a clean foreground inside it.
    var workingCg = fullCg
    if box2d.count == 4 {
      let imgW = CGFloat(fullCg.width)
      let imgH = CGFloat(fullCg.height)
      let ymin = CGFloat(box2d[0]) / 1000.0
      let xmin = CGFloat(box2d[1]) / 1000.0
      let ymax = CGFloat(box2d[2]) / 1000.0
      let xmax = CGFloat(box2d[3]) / 1000.0
      if xmax > xmin, ymax > ymin {
        let rawX = xmin * imgW
        let rawY = ymin * imgH
        let rawW = (xmax - xmin) * imgW
        let rawH = (ymax - ymin) * imgH
        let preCtxPad: CGFloat = 0.08
        let padX = rawW * preCtxPad
        let padY = rawH * preCtxPad
        let cropX = max(0, rawX - padX)
        let cropY = max(0, rawY - padY)
        let cropW = min(rawW + padX * 2, imgW - cropX)
        let cropH = min(rawH + padY * 2, imgH - cropY)
        let pre = CGRect(x: cropX, y: cropY, width: cropW, height: cropH)
        if cropW >= 40, cropH >= 40,
           let preCg = fullCg.cropping(to: pre) {
          workingCg = preCg
          debug["preCropApplied"] = "1"
          debug["preCropW"] = Int(cropW)
          debug["preCropH"] = Int(cropH)
        } else {
          debug["preCropApplied"] = "0"
        }
      }
    } else {
      debug["preCropApplied"] = "0"
    }

    if #available(iOS 17.0, *) {
      var d = enhanceAestyDict(cgImage: workingCg)
      // Merge debug fields without clobbering preCrop info
      if var existing = d["debug"] as? [String: Any] {
        for (k, v) in debug { existing[k] = v }
        d["debug"] = existing
      }
      return d
    }
    debug["error"] = "iOS 17+ required for foreground instance mask"
    return ["uri": "", "debug": debug]
  }

  @available(iOS 17.0, *)
  private func enhanceAestyDict(cgImage: CGImage) -> [String: Any] {
    let imgW = CGFloat(cgImage.width)
    let imgH = CGFloat(cgImage.height)
    let ctx = CIContext(options: [
      .useSoftwareRenderer: false,
      .workingColorSpace: CGColorSpaceCreateDeviceRGB(),
      .outputColorSpace: CGColorSpaceCreateDeviceRGB(),
    ])
    var debug: [String: Any] = ["imgW": Int(imgW), "imgH": Int(imgH)]


    // ── Vision fallback ────────────────────────────────────────────────────
    debug["segmenter"] = "vision"

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()
    do {
      try handler.perform([request])
    } catch {
      debug["error"] = "vision perform failed: \(error.localizedDescription)"
      return ["uri": "", "debug": debug]
    }

    guard let observation = request.results?.first as? VNInstanceMaskObservation,
          !observation.allInstances.isEmpty
    else {
      debug["error"] = "no foreground instances detected"
      return ["uri": "", "debug": debug]
    }

    debug["instanceCount"] = observation.allInstances.count
    NSLog("[enhanceAesty] instances=\(observation.allInstances.count)")

    // Find the LARGEST instance (by bbox area). Vision sometimes returns multiple
    // tiny noise instances; we want the dominant garment.
    var bestInstance: Int? = nil
    var bestArea: CGFloat = 0
    var bestBbox: CGRect = .zero
    var instanceSizes: [String] = []

    for instance in observation.allInstances {
      let instanceSet = IndexSet(integer: Int(instance))
      guard let buf = try? observation.generateMaskedImage(
        ofInstances: instanceSet,
        from: handler,
        croppedToInstancesExtent: true
      ) else { continue }
      let ci = CIImage(cvPixelBuffer: buf)
      let area = ci.extent.width * ci.extent.height
      instanceSizes.append("\(Int(ci.extent.width))x\(Int(ci.extent.height))")
      if area > bestArea {
        bestArea = area
        bestInstance = Int(instance)
        bestBbox = ci.extent
      }
    }

    debug["instanceSizes"] = instanceSizes.joined(separator: ",")

    guard let chosen = bestInstance else {
      debug["error"] = "no usable instance after sizing"
      return ["uri": "", "debug": debug]
    }

    debug["bboxX"] = Int(bestBbox.origin.x)
    debug["bboxY"] = Int(bestBbox.origin.y)
    debug["bboxW"] = Int(bestBbox.width)
    debug["bboxH"] = Int(bestBbox.height)
    debug["bboxFracW"] = String(format: "%.3f", Double(bestBbox.width / imgW))
    debug["bboxFracH"] = String(format: "%.3f", Double(bestBbox.height / imgH))

    // Re-generate the masked buffer for the chosen instance.
    let chosenSet = IndexSet(integer: chosen)
    let maskedBuffer: CVPixelBuffer
    do {
      maskedBuffer = try observation.generateMaskedImage(
        ofInstances: chosenSet,
        from: handler,
        croppedToInstancesExtent: true
      )
    } catch {
      debug["error"] = "generateMaskedImage chosen failed: \(error.localizedDescription)"
      return ["uri": "", "debug": debug]
    }

    let rawCI = CIImage(cvPixelBuffer: maskedBuffer)
    let rawExtent = rawCI.extent

    // Shift to origin so we can render starting at (0,0).
    let shiftedRaw = rawCI.transformed(
      by: CGAffineTransform(translationX: -rawExtent.origin.x,
                            y: -rawExtent.origin.y)
    )
    let renderRect = CGRect(x: 0, y: 0, width: Int(rawExtent.width), height: Int(rawExtent.height))

    // KEY FIX: force a CGImage round-trip with explicit RGBA8 format. This is the
    // single most important step — Vision's CVPixelBuffer alpha format isn't always
    // interpreted correctly by `CIImage(cvPixelBuffer:)` directly, which makes the
    // subsequent `composited(over: white)` a no-op.
    guard let cgRGBA = ctx.createCGImage(
      shiftedRaw,
      from: renderRect,
      format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB()
    ) else {
      debug["error"] = "createCGImage RGBA8 failed"
      return ["uri": "", "debug": debug]
    }

    let coverage = computeAlphaCoverage(cgImage: cgRGBA)
    debug["alphaCoverage"] = String(format: "%.3f", coverage)

    // If alpha coverage is essentially 100%, the buffer has no transparency at all —
    // either Vision saw the entire bbox as foreground (likely for tight crops) OR
    // the buffer's alpha channel never made it through. In either case the bbox-only
    // crop is still useful: it's the garment region of the original photo. Build the
    // composite from that, falling back to the original color crop on white.
    let cleanMaskedCI = CIImage(cgImage: cgRGBA)
    let composited: CIImage
    if coverage >= 0.998 {
      // No useful alpha — fall back to compositing the ORIGINAL image cropped to
      // the bbox. At least the user gets a tight crop of the item.
      let originalCI = CIImage(cgImage: cgImage)
      let origCrop = originalCI.cropped(to: bestBbox)
      let origShifted = origCrop.transformed(
        by: CGAffineTransform(translationX: -origCrop.extent.origin.x,
                              y: -origCrop.extent.origin.y)
      )
      composited = origShifted
      debug["fallback"] = "no-alpha-using-original-crop"
    } else {
      let clearBg = ciClearImage(extent: cleanMaskedCI.extent)
      composited = cleanMaskedCI.composited(over: clearBg)
    }

    // Hand off to the shared Aesty finishing pipeline (tight-trim, 8% pad,
    // polish, aspect-aware cover fit, PNG write).
    return writeAestyEnhancedPNG(composited: composited, ctx: ctx, debug: debug)
  }

  /// Fully transparent CIImage over `extent` (for compositing under RGBA foreground).
  private func ciClearImage(extent: CGRect) -> CIImage {
    let c = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
    return CIImage(color: c).cropped(to: extent)
  }

  /// Scale `image` with preserved aspect ratio so it **covers** a square of `side`×`side`, centered on transparent canvas.
  private func squareCoverFitTransparent(image: CIImage, side: CGFloat) -> CIImage? {
    let e = image.extent
    guard e.width >= 1, e.height >= 1, e.width.isFinite, e.height.isFinite, side >= 32 else { return nil }
    let w = e.width
    let h = e.height
    let scale = max(side / w, side / h)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let sw = w * scale
    let sh = h * scale
    let tx = (side - sw) / 2
    let ty = (side - sh) / 2
    let placed = scaled.transformed(by: CGAffineTransform(translationX: tx, y: ty))
    let clearSquare = ciClearImage(extent: CGRect(x: 0, y: 0, width: side, height: side))
    return placed.composited(over: clearSquare).cropped(to: CGRect(x: 0, y: 0, width: side, height: side))
  }

  /// Contain-fit onto an arbitrary rectangular canvas. Scales `image` so its
  /// LONGER dimension matches the canvas (min scale) — the garment fills the
  /// canvas edge-to-edge on one axis, with centered bands of transparency on
  /// the other axis. Preserves the full garment without clipping — Aesty-style
  /// "fills the card" framing when the canvas aspect matches the garment.
  private func containFitTransparent(image: CIImage, width: CGFloat, height: CGFloat) -> CIImage? {
    let e = image.extent
    guard e.width >= 1, e.height >= 1, e.width.isFinite, e.height.isFinite,
          width >= 32, height >= 32 else { return nil }
    // Contain-fit (min scale) — keeps the whole garment visible and fills as
    // much canvas as the tighter axis allows.
    let scale = min(width / e.width, height / e.height)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let sw = e.width * scale
    let sh = e.height * scale
    let tx = (width - sw) / 2
    let ty = (height - sh) / 2
    let placed = scaled.transformed(by: CGAffineTransform(translationX: tx, y: ty))
    let clearCanvas = ciClearImage(extent: CGRect(x: 0, y: 0, width: width, height: height))
    return placed.composited(over: clearCanvas).cropped(
      to: CGRect(x: 0, y: 0, width: width, height: height)
    )
  }

  /// Sample alpha values across the image and report the fraction of pixels with alpha > 16.
  private func computeAlphaCoverage(cgImage: CGImage) -> Double {
    let w = cgImage.width
    let h = cgImage.height
    guard w > 0, h > 0 else { return 0 }
    var bytes = [UInt8](repeating: 0, count: w * h * 4)
    let space = CGColorSpaceCreateDeviceRGB()
    guard let cgCtx = CGContext(
      data: &bytes,
      width: w, height: h,
      bitsPerComponent: 8, bytesPerRow: w * 4,
      space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return 0 }
    cgCtx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))

    var fg = 0
    var sampled = 0
    let step = max(1, min(w, h) / 64)
    var y = 0
    while y < h {
      var x = 0
      while x < w {
        let i = (y * w + x) * 4 + 3
        if bytes[i] > 16 { fg += 1 }
        sampled += 1
        x += step
      }
      y += step
    }
    return sampled > 0 ? Double(fg) / Double(sampled) : 0
  }

  // Old single-string variant — kept only as reference. Not called.
  @available(iOS 17.0, *)
  private func enhanceAestyLegacy(cgImage: CGImage) -> String? {
    let imgW = CGFloat(cgImage.width)
    let imgH = CGFloat(cgImage.height)

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()
    do {
      try handler.perform([request])
    } catch {
      NSLog("[enhanceAesty] Vision request failed: \(error)")
      return nil
    }
    guard let observation = request.results?.first as? VNInstanceMaskObservation,
          !observation.allInstances.isEmpty
    else {
      NSLog("[enhanceAesty] No foreground instances")
      return nil
    }

    let instances = observation.allInstances
    NSLog("[enhanceAesty] Vision found \(instances.count) instance(s)")

    // Pull the *pure* grayscale mask scaled to the original image. This is more
    // reliable than generateMaskedImage (whose returned buffer's alpha behavior
    // varies and can end up as opaque RGB after CIImage round-trip).
    let maskBuffer: CVPixelBuffer
    do {
      maskBuffer = try observation.generateScaledMaskForImage(
        forInstances: instances,
        from: handler
      )
    } catch {
      NSLog("[enhanceAesty] generateScaledMaskForImage failed: \(error)")
      return nil
    }

    // Scale the mask to exactly match the original image size (Vision can return
    // it at a smaller resolution).
    var maskCI = CIImage(cvPixelBuffer: maskBuffer)
    let mw = maskCI.extent.width
    let mh = maskCI.extent.height
    if mw != imgW || mh != imgH, mw > 0, mh > 0 {
      let sx = imgW / mw
      let sy = imgH / mh
      maskCI = maskCI
        .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        .cropped(to: CGRect(x: 0, y: 0, width: imgW, height: imgH))
    }

    // Composite original × mask over warm neutral via CIBlendWithMask.
    let originalCI = CIImage(cgImage: cgImage)
    let bgWarm = CIImage(color: CIColor(red: 245.0/255.0, green: 241.0/255.0, blue: 236.0/255.0))
    let whiteFull = bgWarm.cropped(to: CGRect(x: 0, y: 0, width: imgW, height: imgH))
    guard let blend = CIFilter(name: "CIBlendWithMask") else { return nil }
    blend.setValue(originalCI, forKey: kCIInputImageKey)
    blend.setValue(whiteFull, forKey: kCIInputBackgroundImageKey)
    blend.setValue(maskCI, forKey: kCIInputMaskImageKey)
    guard let blended = blend.outputImage else { return nil }

    // Tight bbox by scanning the mask (in original image coords, CI bottom-left).
    let bbox = tightBboxFromMask(maskCI, imgW: imgW, imgH: imgH)
      ?? CGRect(x: 0, y: 0, width: imgW, height: imgH)
    NSLog("[enhanceAesty] mask bbox: \(bbox) of \(imgW)x\(imgH)")

    // 15% padding per side — natural aspect ratio, no square lock.
    let padX = bbox.width * 0.15
    let padY = bbox.height * 0.15
    let px = max(0, bbox.origin.x - padX)
    let py = max(0, bbox.origin.y - padY)
    let cropRect = CGRect(
      x: px,
      y: py,
      width:  min(bbox.width  + padX * 2, imgW - px),
      height: min(bbox.height + padY * 2, imgH - py)
    )

    let composited = blended.cropped(to: cropRect)

    // Shift so extent origin is (0,0) for a clean output image.
    let shifted = composited.transformed(
      by: CGAffineTransform(translationX: -composited.extent.origin.x,
                            y: -composited.extent.origin.y)
    )

    // Strong Aesty-grade polish (but DO NOT force to pure white so we keep the tan background)
    let polished = polishAesty(image: shifted)
    let cleaned = polished

    let ctx = CIContext(options: [.useSoftwareRenderer: false])
    let extent = cleaned.extent
    guard extent.width.isFinite, extent.height.isFinite,
          extent.width > 0, extent.height > 0,
          let cgOut = ctx.createCGImage(cleaned, from: extent),
          let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.97)
    else { return nil }

    let name = "ootd-enhance-\(UUID().uuidString).jpg"
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
    do {
      try jpeg.write(to: url, options: .atomic)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  /// Scan a grayscale mask CIImage and return the tight bounding box of all pixels
  /// brighter than a small threshold. Returned rect is in CI (bottom-left) coordinates
  /// at full image resolution.
  private func tightBboxFromMask(_ mask: CIImage, imgW: CGFloat, imgH: CGFloat) -> CGRect? {
    let ctx = CIContext(options: [.useSoftwareRenderer: false])
    let targetW: CGFloat = 256
    guard imgW > 0, imgH > 0 else { return nil }
    let scale = targetW / imgW
    let smallW = Int(targetW)
    let smallH = max(1, Int((imgH * scale).rounded()))
    let scaled = mask.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let renderRect = CGRect(x: 0, y: 0, width: smallW, height: smallH)
    guard let cg = ctx.createCGImage(scaled, from: renderRect) else { return nil }

    let w = cg.width
    let h = cg.height
    var bytes = [UInt8](repeating: 0, count: w * h * 4)
    let space = CGColorSpaceCreateDeviceRGB()
    guard let cgCtx = CGContext(
      data: &bytes,
      width: w, height: h,
      bitsPerComponent: 8, bytesPerRow: w * 4,
      space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    cgCtx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

    let threshold: UInt8 = 24
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h {
      let rowStart = y * w * 4
      for x in 0..<w {
        let i = rowStart + x * 4
        // Mask is grayscale rendered into RGBA — R==G==B; sample R.
        if bytes[i] > threshold {
          if x < minX { minX = x }
          if x > maxX { maxX = x }
          if y < minY { minY = y }
          if y > maxY { maxY = y }
        }
      }
    }
    if maxX < 0 || maxY < 0 { return nil }

    let invScale = 1.0 / scale
    let xFull = CGFloat(minX) * invScale
    let wFull = CGFloat(maxX - minX + 1) * invScale
    let topCgFull = CGFloat(minY) * invScale
    let hFull = CGFloat(maxY - minY + 1) * invScale
    // Convert top-down CG y to bottom-left CI y.
    let yCi = imgH - (topCgFull + hFull)
    return CGRect(
      x: max(0, xFull),
      y: max(0, yCi),
      width: min(wFull, imgW - max(0, xFull)),
      height: min(hFull, imgH - max(0, yCi))
    )
  }

  /// Aesty-grade garment polish: crisp fabric texture, natural contrast, saturated colors.
  private func polishAesty(image: CIImage) -> CIImage {
    var result = image

    let sharpen = CIFilter.unsharpMask()
    sharpen.inputImage = result
    sharpen.radius = 3.0
    sharpen.intensity = 0.80
    if let out = sharpen.outputImage { result = out }

    let colorCtrl = CIFilter.colorControls()
    colorCtrl.inputImage = result
    colorCtrl.brightness = 0.05
    colorCtrl.contrast = 1.22
    colorCtrl.saturation = 1.13
    if let out = colorCtrl.outputImage { result = out }

    return result
  }

  /// Lift near-white pixels to pure #FFFFFF so the background is clinically clean
  /// while leaving mid-tones (the garment) untouched. Done via a tiny highlight boost
  /// and a hard clamp.
  private func forceNearWhiteToWhite(image: CIImage) -> CIImage {
    guard let boosted = CIFilter(name: "CIColorMatrix", parameters: [
      kCIInputImageKey: image,
      "inputRVector": CIVector(x: 1.05, y: 0, z: 0, w: 0),
      "inputGVector": CIVector(x: 0, y: 1.05, z: 0, w: 0),
      "inputBVector": CIVector(x: 0, y: 0, z: 1.05, w: 0),
      "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
      "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 0),
    ])?.outputImage else { return image }

    guard let clamped = CIFilter(name: "CIColorClamp", parameters: [
      kCIInputImageKey: boosted,
      "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
      "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
    ])?.outputImage else { return boosted }

    return clamped
  }

  /// Aesty-style finishing pipeline shared by the Vision paths:
  /// 1) Re-trim to the TIGHT alpha bbox (kills any slack around the garment).
  /// 2) 8% breathing-room pad (Aesty-style tight framing, not loose 15%).
  /// 3) Polish (sharpen + contrast/saturation).
  /// 4) Aspect-aware cover fit — tall items get a 1024×1382 canvas (1.35:1),
  ///    everything else gets square 1024×1024. Makes tops/dresses fill the
  ///    preview card vertically instead of floating in dead space.
  /// 5) PNG encode + file write. Returns the `{uri, debug}` dict.
  private func writeAestyEnhancedPNG(
    composited: CIImage,
    ctx: CIContext,
    debug: [String: Any]
  ) -> [String: Any] {
    var d = debug

    // 1) Tight-trim alpha. Vision's bbox can leave slack; trimming the actual
    //    non-transparent pixels gives us the real garment extent.
    let trimmed: CIImage
    if let trimRect = autoTrimAlpha(composited, context: ctx) {
      let t = composited.cropped(to: trimRect)
      trimmed = t.transformed(
        by: CGAffineTransform(translationX: -t.extent.origin.x,
                              y: -t.extent.origin.y)
      )
      d["tightW"] = Int(trimmed.extent.width)
      d["tightH"] = Int(trimmed.extent.height)
    } else {
      trimmed = composited
    }

    // 2) 8% pad (Aesty-style breathing room).
    let padX = trimmed.extent.width * 0.08
    let padY = trimmed.extent.height * 0.08
    let paddedRect = CGRect(
      x: -padX, y: -padY,
      width: trimmed.extent.width + padX * 2,
      height: trimmed.extent.height + padY * 2
    )
    let paddedClear = ciClearImage(extent: paddedRect)
    let paddedComposed = trimmed.composited(over: paddedClear).cropped(to: paddedRect)
    let paddedShifted = paddedComposed.transformed(
      by: CGAffineTransform(translationX: -paddedComposed.extent.origin.x,
                            y: -paddedComposed.extent.origin.y)
    )
    let polished = polishAesty(image: paddedShifted)

    // 3) Aspect-aware canvas: tall items → 1024×1382, else square 1024².
    let aspect = polished.extent.height / max(polished.extent.width, 1)
    let canvasW = kCutoutSquareSide
    let canvasH = aspect > 1.35 ? kCutoutSquareSide * 1.35 : kCutoutSquareSide
    d["canvasW"] = Int(canvasW)
    d["canvasH"] = Int(canvasH)
    guard let squared = containFitTransparent(image: polished, width: canvasW, height: canvasH) else {
      d["error"] = "cover fit failed"
      return ["uri": "", "debug": d]
    }
    guard let cgOut = ctx.createCGImage(squared, from: squared.extent),
          let png = UIImage(cgImage: cgOut).pngData()
    else {
      d["error"] = "png encode failed"
      return ["uri": "", "debug": d]
    }
    d["outputW"] = Int(squared.extent.width)
    d["outputH"] = Int(squared.extent.height)

    let name = "ootd-enhance-\(UUID().uuidString).png"
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
    do {
      try png.write(to: url, options: .atomic)
      return ["uri": url.absoluteString, "debug": d]
    } catch {
      d["error"] = "file write failed: \(error.localizedDescription)"
      return ["uri": "", "debug": d]
    }
  }

  // ── segmentItems entry point ───────────────────────────────────────────────

  private func performSegmentation(base64: String) throws -> [String] {
    guard let data = Data(base64Encoded: base64),
          let uiImage = UIImage(data: data),
          let cgImage = normalizedCGImage(from: uiImage)
    else { return [] }

    if #available(iOS 17.0, *) {
      return try segmentInstances(cgImage: cgImage)
    }
    return []
  }

  // ── Per-instance segmentation (iOS 17+) ────────────────────────────────────

  @available(iOS 17.0, *)
  private func segmentInstances(cgImage: CGImage) throws -> [String] {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()
    try handler.perform([request])

    guard let observation = request.results?.first as? VNInstanceMaskObservation,
          !observation.allInstances.isEmpty
    else { return [] }

    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    // Small outward inset so anti-aliased mask edges aren't clipped — auto-trim
    // below reclaims the tight bbox, so large paddings here just waste frame space.
    let padding: CGFloat = 0.05

    var results: [String] = []

    for instance in observation.allInstances {
      do {
        let instanceSet = IndexSet(integer: Int(instance))

        // Cropped-to-instance buffer is already in the correct window (full-res segment).
        // IMPORTANT: `croppedCI.extent` is in *crop-buffer* space (origin ~0,0). The old
        // code reused those numbers as a rect into the *full-frame* mask, which clipped
        // the wrong region (e.g. only the toe of a shoe). Use this buffer directly.
        let croppedBuffer = try observation.generateMaskedImage(
          ofInstances: instanceSet,
          from: handler,
          croppedToInstancesExtent: true
        )
        var maskedCI = CIImage(cvPixelBuffer: croppedBuffer)
        let extent = maskedCI.extent

        // Slight outward inset in *crop-buffer* space (unlike the old full-image crop bug).
        let pad = min(extent.width, extent.height) * padding
        maskedCI = maskedCI.cropped(to: extent.insetBy(dx: -pad, dy: -pad))

        let clearBg = ciClearImage(extent: maskedCI.extent)
        let composited = maskedCI.composited(over: clearBg)

        let shifted = composited.transformed(
          by: CGAffineTransform(
            translationX: -composited.extent.origin.x,
            y: -composited.extent.origin.y
          )
        )

        let polished = polish(image: shifted)

        // Auto-trim transparent margins → tight bbox → 8% breathing room → contain-fit.
        // Cover-fit was clipping wide items (slides, belts, chains) so the thumbnail
        // showed only a thin center strip. Contain-fit + breathing room preserves
        // the whole item with a bit of space so it doesn't look over-zoomed.
        let norm = polished.transformed(
          by: CGAffineTransform(
            translationX: -polished.extent.origin.x,
            y: -polished.extent.origin.y
          )
        )
        let trimmed: CIImage
        if let trimRect = autoTrimAlpha(norm, context: ciContext),
           trimRect.width >= 8, trimRect.height >= 8 {
          let cropped = norm.cropped(to: trimRect)
          let tight = cropped.transformed(
            by: CGAffineTransform(
              translationX: -cropped.extent.origin.x,
              y: -cropped.extent.origin.y
            )
          )
          let padX = tight.extent.width * 0.08
          let padY = tight.extent.height * 0.08
          let paddedExtent = CGRect(
            x: -padX, y: -padY,
            width: tight.extent.width + padX * 2,
            height: tight.extent.height + padY * 2
          )
          let paddedBg = ciClearImage(extent: paddedExtent)
          let padded = tight.composited(over: paddedBg).cropped(to: paddedExtent)
          trimmed = padded.transformed(
            by: CGAffineTransform(
              translationX: -padded.extent.origin.x,
              y: -padded.extent.origin.y
            )
          )
        } else {
          trimmed = norm
        }
        // Aspect-aware canvas: tall → 1024×1382, wide → 1382×1024, else square.
        // Contain-fit preserves full garment; matching canvas aspect makes it
        // fill the preview card instead of floating in dead space.
        let aspect = trimmed.extent.height / max(trimmed.extent.width, 1)
        let canvasW: CGFloat
        let canvasH: CGFloat
        if aspect > 1.35 {
          canvasW = kCutoutSquareSide
          canvasH = kCutoutSquareSide * 1.35
        } else if aspect < (1.0 / 1.35) {
          canvasW = kCutoutSquareSide * 1.35
          canvasH = kCutoutSquareSide
        } else {
          canvasW = kCutoutSquareSide
          canvasH = kCutoutSquareSide
        }
        guard let squared = containFitTransparent(image: trimmed, width: canvasW, height: canvasH)
        else { continue }

        if let cgOut = ciContext.createCGImage(squared, from: squared.extent),
           let png = UIImage(cgImage: cgOut).pngData() {
          results.append("data:image/png;base64," + png.base64EncodedString())
        }
      } catch {
        continue
      }
    }

    return results
  }

  // ── cropGarmentsFromOriginal: Vision + per-box crop in one pass ────────────
  // Runs Vision on the original image to get a full-frame mask, then crops each
  // box from mask+original in the SAME coordinate system. No scale hacks.

  private func cropGarmentsFromOriginalFreshMask(originalBase64: String, boxes: [[Double]]) -> [String] {
    guard !boxes.isEmpty,
          let data = Data(base64Encoded: originalBase64),
          let uiImage = UIImage(data: data),
          let cgImage = normalizedCGImage(from: uiImage)
    else { return [] }

    if #available(iOS 17.0, *) {
      return cropGarmentsFromOriginalImpl(cgImage: cgImage, boxes: boxes)
    }
    // Pre-iOS-17: plain original crops, no background removal
    return cropGarmentsFromOriginalOnly(originalBase64: originalBase64, boxes: boxes)
  }

  @available(iOS 17.0, *)
  private func cropGarmentsFromOriginalImpl(cgImage: CGImage, boxes: [[Double]]) -> [String] {
    let imgW = CGFloat(cgImage.width)
    let imgH = CGFloat(cgImage.height)
    let originalCI = CIImage(cgImage: cgImage)
    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    var results: [String] = []

    for box in boxes {
      guard box.count == 4 else { continue }
      let ymin = CGFloat(box[0]) / 1000.0
      let xmin = CGFloat(box[1]) / 1000.0
      let ymax = CGFloat(box[2]) / 1000.0
      let xmax = CGFloat(box[3]) / 1000.0
      guard xmax > xmin, ymax > ymin else { continue }

      // Pixel bounds in CGImage (top-left origin, y increases downward).
      let rawX = xmin * imgW
      let rawY = ymin * imgH
      let rawW = (xmax - xmin) * imgW
      let rawH = (ymax - ymin) * imgH

      // 3% context pad — just enough for Vision to see clean garment edges.
      // JS boxes are now tight (Gemini's box_2d = collar-to-hem for shirts, etc.),
      // so large padding re-introduces the head/pants we just removed from the crop.
      let ctxPad: CGFloat = 0.03
      let padX = rawW * ctxPad
      let padY = rawH * ctxPad
      let cgCropX = max(0.0, rawX - padX)
      let cgCropY = max(0.0, rawY - padY)
      let cgCropW = min(rawW + padX * 2, imgW - cgCropX)
      let cgCropH = min(rawH + padY * 2, imgH - cgCropY)
      guard cgCropW >= 40, cgCropH >= 40 else { continue }

      // CIImage rect for the same region (bottom-left origin).
      let ciCropY = imgH - (cgCropY + cgCropH)
      let preCropCIRect = CGRect(x: cgCropX, y: ciCropY, width: cgCropW, height: cgCropH)
      let origCropCI = originalCI.cropped(to: preCropCIRect)
      let shiftedOrig = origCropCI.transformed(
        by: CGAffineTransform(translationX: -origCropCI.extent.origin.x,
                              y: -origCropCI.extent.origin.y)
      )

      var finalComposited: CIImage = shiftedOrig
      var usedMask = false

      // ── Per-item Vision segmentation on the pre-cropped region ──────────
      // VNGenerateForegroundInstanceMaskRequest runs on the pre-cropped patch
      // (not the full body photo) so we never get full-person silhouettes
      // leaking across items.
      let cgCropRect = CGRect(x: cgCropX, y: cgCropY, width: cgCropW, height: cgCropH)
      if let preCroppedCG = cgImage.cropping(to: cgCropRect) {
        let handler = VNImageRequestHandler(cgImage: preCroppedCG, options: [:])
        let request = VNGenerateForegroundInstanceMaskRequest()
        do {
          try handler.perform([request])
          if let observation = request.results?.first as? VNInstanceMaskObservation,
             !observation.allInstances.isEmpty {

            let buffer = try observation.generateMaskedImage(
              ofInstances: observation.allInstances,
              from: handler,
              croppedToInstancesExtent: false
            )
            var maskCI = CIImage(cvPixelBuffer: buffer)

            // Vision may return the mask at a lower resolution than the pre-crop;
            // scale it up so every pixel aligns correctly.
            let mw = maskCI.extent.width
            let mh = maskCI.extent.height
            let expW = CGFloat(preCroppedCG.width)
            let expH = CGFloat(preCroppedCG.height)
            if (mw != expW || mh != expH), mw > 0, mh > 0 {
              let sx = expW / mw
              let sy = expH / mh
              maskCI = maskCI
                .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                .cropped(to: CGRect(x: 0, y: 0, width: expW, height: expH))
            }

            let coverage = alphaCoverageInBox(maskCI, context: ciContext)
            if coverage >= 0.04 {
              let clearBg = ciClearImage(extent: maskCI.extent)
              let composed = maskCI.composited(over: clearBg)
              finalComposited = composed.transformed(
                by: CGAffineTransform(translationX: -composed.extent.origin.x,
                                      y: -composed.extent.origin.y)
              )
              usedMask = true
            }
          }
        } catch {
          // Vision failed for this box — plain original crop fallback below.
        }
      }

      let polished = polish(image: finalComposited)

      if usedMask {
        if let uri = pngDataUriFromPolishedTransparentWithFallback(
          polished: polished,
          fallbackShiftedOrig: shiftedOrig,
          context: ciContext
        ) {
          results.append(uri)
        }
      } else {
        // No mask — contain-fit original crop into white square (consistent output size).
        if let squared = squareContainFitWhite(image: polished, side: kCutoutSquareSide),
           let cgOut = ciContext.createCGImage(squared, from: squared.extent),
           let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.92) {
          results.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
      }
    }

    return results
  }

  // ── DELETED: full-frame Vision mask path (kept as reference comment) ──────
  // The old approach ran one VNGenerateForegroundInstanceMaskRequest on the
  // whole photo, then sliced the single full-person silhouette by garment box.
  // Result: every item (shirt, pants, glasses) got a chunk of the same
  // body-outline mask → heads/torsos leaked into shirt crops, glasses showed
  // a face silhouette, etc.  Per-box segmentation above fixes all of these.
  // ─────────────────────────────────────────────────────────────────────────

  @available(iOS 17.0, *)
  private func cropGarmentsFromOriginalImpl_unused(cgImage: CGImage, boxes: [[Double]]) -> [String] {
    let imgW = CGFloat(cgImage.width)
    let imgH = CGFloat(cgImage.height)
    let originalCI = CIImage(cgImage: cgImage)
    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    let padding: CGFloat = 0.08

    var fullMaskCI: CIImage? = nil
    do {
      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      let request = VNGenerateForegroundInstanceMaskRequest()
      try handler.perform([request])
      if let observation = request.results?.first as? VNInstanceMaskObservation,
         !observation.allInstances.isEmpty {
        let buffer = try observation.generateMaskedImage(
          ofInstances: observation.allInstances,
          from: handler,
          croppedToInstancesExtent: false
        )
        var maskCI = CIImage(cvPixelBuffer: buffer)
        // Vision often returns the mask buffer at a lower resolution than the
        // original photo (e.g. 1500×2000 for a 3000×4000 input). We MUST scale
        // the mask to match original dimensions so cropRect coordinates align.
        // Without this, crops grab the wrong region and clip garments.
        let mw = maskCI.extent.width
        let mh = maskCI.extent.height
        if mw != imgW || mh != imgH, mw > 0, mh > 0 {
          let sx = imgW / mw
          let sy = imgH / mh
          maskCI = maskCI
            .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .cropped(to: CGRect(x: 0, y: 0, width: imgW, height: imgH))
        }
        fullMaskCI = maskCI
      }
    } catch {
      fullMaskCI = nil
    }

    var results: [String] = []

    for box in boxes {
      guard box.count == 4,
            let rect = cropRect(for: box, imgW: imgW, imgH: imgH, padding: padding)
      else { continue }

      // Always compute the original crop so we have a fallback if compositing fails.
      let origCrop = originalCI.cropped(to: rect)
      let shiftedOrig = origCrop.transformed(
        by: CGAffineTransform(translationX: -origCrop.extent.origin.x,
                              y: -origCrop.extent.origin.y)
      )

      let finalComposited: CIImage
      var useMask = false
      if let mask = fullMaskCI {
        let maskCrop = mask.cropped(to: rect)
        // Per-box coverage check: if the mask is effectively empty inside this box
        // (e.g. flat-lay of slides on a floor where Vision missed the item), skip
        // the mask for THIS item and use the plain original crop instead.
        // This keeps background removal working when Vision succeeds, and gracefully
        // falls through to a visible crop when Vision fails on individual items.
        let coverage = alphaCoverageInBox(maskCrop, context: ciContext)
        if coverage >= 0.04 {
          let clearBg = ciClearImage(extent: maskCrop.extent)
          let composed = maskCrop.composited(over: clearBg)
          finalComposited = composed.transformed(
            by: CGAffineTransform(translationX: -composed.extent.origin.x,
                                  y: -composed.extent.origin.y)
          )
          useMask = true
        } else {
          finalComposited = shiftedOrig
        }
      } else {
        finalComposited = shiftedOrig
      }

      let polished = polish(image: finalComposited)

      if useMask {
        if let uri = self.pngDataUriFromPolishedTransparentWithFallback(
          polished: polished,
          fallbackShiftedOrig: shiftedOrig,
          context: ciContext
        ) {
          results.append(uri)
        }
      } else {
        // Plain crop path (Vision failed for this item): contain-fit into square with white bg.
        // Ensures consistent 1024×1024 square output even when falling back, no rectangles.
        if let squared = squareContainFitWhite(image: polished, side: kCutoutSquareSide),
           let cgOut = ciContext.createCGImage(squared, from: squared.extent),
           let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.92) {
          results.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
      }
    }

    return results
  }

  /// Fraction of pixels inside a cropped mask that have alpha > threshold.
  /// Used to detect "Vision missed this item" — if mask is essentially empty
  /// inside the box, we fall back to plain original crop for that item.
  private func alphaCoverageInBox(_ image: CIImage, context: CIContext) -> Double {
    let extent = image.extent
    guard extent.width >= 4, extent.height >= 4 else { return 0 }
    // Downsample aggressively for speed — we just need a rough coverage estimate.
    let targetSide: CGFloat = 96
    let scale = min(targetSide / extent.width, targetSide / extent.height, 1.0)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let shifted = scaled.transformed(
      by: CGAffineTransform(translationX: -scaled.extent.origin.x,
                            y: -scaled.extent.origin.y)
    )
    let rect = CGRect(origin: .zero, size: shifted.extent.size)
    guard rect.width >= 1, rect.height >= 1,
          let cg = context.createCGImage(
            shifted, from: rect, format: .RGBA8,
            colorSpace: CGColorSpaceCreateDeviceRGB()
          )
    else { return 0 }
    let w = cg.width
    let h = cg.height
    guard w > 0, h > 0 else { return 0 }
    var bytes = [UInt8](repeating: 0, count: w * h * 4)
    guard let cgCtx = CGContext(
      data: &bytes, width: w, height: h,
      bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return 0 }
    cgCtx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var fg = 0
    let total = w * h
    for i in 0..<total {
      if bytes[i * 4 + 3] > 16 { fg += 1 }
    }
    return total > 0 ? Double(fg) / Double(total) : 0
  }

  // ── cropGarments: crop box_2d regions from a masked image ─────────────────
  // boxes: [[ymin, xmin, ymax, xmax]] in 0–1000 coords

  private func cropGarmentsFromMasked(maskedBase64: String, boxes: [[Double]]) -> [String] {
    guard !boxes.isEmpty,
          let data = Data(base64Encoded: maskedBase64),
          let uiImage = UIImage(data: data),
          let cgImage = normalizedCGImage(from: uiImage)
    else { return [] }

    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    let sourceCI = CIImage(cgImage: cgImage)
    let imgW = CGFloat(cgImage.width)
    let imgH = CGFloat(cgImage.height)
    let padding: CGFloat = 0.18
    let sourceHasAlpha = cgImageHasAlpha(cgImage)

    var results: [String] = []

    for box in boxes {
      guard box.count == 4,
            let cropRect = cropRect(for: box, imgW: imgW, imgH: imgH, padding: padding)
      else { continue }

      let cropped = sourceCI.cropped(to: cropRect)

      let shifted: CIImage
      if sourceHasAlpha {
        let clearBg = ciClearImage(extent: cropped.extent)
        let composited = cropped.composited(over: clearBg)
        shifted = composited.transformed(
          by: CGAffineTransform(translationX: -composited.extent.origin.x,
                                y: -composited.extent.origin.y)
        )
      } else {
        let white = CIImage(color: .white).cropped(to: cropped.extent)
        let composited = cropped.composited(over: white)
        shifted = composited.transformed(
          by: CGAffineTransform(translationX: -composited.extent.origin.x,
                                y: -composited.extent.origin.y)
        )
      }

      let polished = polish(image: shifted)

      if sourceHasAlpha {
        if let uri = pngDataUriFromPolishedTransparentWithFallback(
          polished: polished,
          fallbackShiftedOrig: nil,
          context: ciContext
        ) {
          results.append(uri)
        }
      } else if let cgOut = ciContext.createCGImage(polished, from: polished.extent),
                let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.92) {
        results.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
      }
    }

    return results
  }

  private func cgImageHasAlpha(_ cg: CGImage) -> Bool {
    switch cg.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast:
      return false
    default:
      return true
    }
  }

  // ── Masked crop with fallback to original when mask region is empty ───────

  private func cropGarmentsWithOriginalFallback(maskedBase64: String, originalBase64: String, boxes: [[Double]]) -> [String] {
    guard !boxes.isEmpty,
          let maskData = Data(base64Encoded: maskedBase64),
          let origData = Data(base64Encoded: originalBase64),
          let maskUIImage = UIImage(data: maskData),
          let origUIImage = UIImage(data: origData),
          let maskCG = normalizedCGImage(from: maskUIImage),
          let origCG = normalizedCGImage(from: origUIImage)
    else { return [] }

    let origCI = CIImage(cgImage: origCG)
    let ow = CGFloat(origCG.width)
    let oh = CGFloat(origCG.height)
    let mw = CGFloat(maskCG.width)
    let mh = CGFloat(maskCG.height)

    // Align mask to original pixel grid (library vs camera JPEG size mismatch).
    let maskBase = CIImage(cgImage: maskCG)
    let maskCI: CIImage
    if mw != ow || mh != oh {
      let sx = ow / mw
      let sy = oh / mh
      let scaled = maskBase.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
      let tx = -scaled.extent.origin.x
      let ty = -scaled.extent.origin.y
      maskCI = scaled.transformed(by: CGAffineTransform(translationX: tx, y: ty)).cropped(to: CGRect(x: 0, y: 0, width: ow, height: oh))
    } else {
      maskCI = maskBase
    }

    let imgW = ow
    let imgH = oh
    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    let padding: CGFloat = 0.18
    var results: [String] = []

    for box in boxes {
      guard box.count == 4 else { continue }
      guard let cropRect = self.cropRect(for: box, imgW: imgW, imgH: imgH, padding: padding) else { continue }

      let maskedCrop = maskCI.cropped(to: cropRect)
      let origCrop = origCI.cropped(to: cropRect)
      let shiftedOrig = origCrop.transformed(
        by: CGAffineTransform(translationX: -origCrop.extent.origin.x, y: -origCrop.extent.origin.y)
      )

      if self.isMostlyEmptyMaskedCrop(maskedCrop, context: ciContext) {
        // Mask patch reads “empty” — still try original colors + transparent bg via mask alpha.
        let fgStrength = self.meanForegroundStrength(maskPatch: maskedCrop, context: ciContext)
        if fgStrength >= 0.003,
           let composed = self.compositeOriginalOnTransparent(origCrop: origCrop, maskPatch: maskedCrop) {
          let shifted = composed.transformed(
            by: CGAffineTransform(translationX: -composed.extent.origin.x, y: -composed.extent.origin.y)
          )
          let polished = polish(image: shifted)
          if let uri = self.pngDataUriFromPolishedTransparentWithFallback(
            polished: polished,
            fallbackShiftedOrig: shiftedOrig,
            context: ciContext
          ) {
            results.append(uri)
          }
        } else {
          let rawCrop = origCrop
          let shifted = rawCrop.transformed(
            by: CGAffineTransform(translationX: -rawCrop.extent.origin.x, y: -rawCrop.extent.origin.y)
          )
          let polished = polish(image: shifted)
          if let uri = self.pngDataUriFromPolishedTransparentWithFallback(
            polished: polished,
            fallbackShiftedOrig: nil,
            context: ciContext
          ) {
            results.append(uri)
          }
        }
      } else {
        let clearBg = ciClearImage(extent: maskedCrop.extent)
        let composited = maskedCrop.composited(over: clearBg)
        let shifted = composited.transformed(
          by: CGAffineTransform(translationX: -composited.extent.origin.x, y: -composited.extent.origin.y)
        )
        let polished = polish(image: shifted)
        if let uri = self.pngDataUriFromPolishedTransparentWithFallback(
          polished: polished,
          fallbackShiftedOrig: shiftedOrig,
          context: ciContext
        ) {
          results.append(uri)
        }
      }
    }

    return results
  }

  /// How much non-white signal is in a person-on-white mask patch (0 = empty).
  private func meanForegroundStrength(maskPatch: CIImage, context: CIContext) -> CGFloat {
    guard let mat = CIFilter(name: "CIColorMatrix", parameters: [
      kCIInputImageKey: maskPatch,
      "inputRVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputGVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputBVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
      "inputBiasVector": CIVector(x: 3, y: 3, z: 3, w: 0),
    ])?.outputImage,
          let clamped = CIFilter(name: "CIColorClamp", parameters: [
            kCIInputImageKey: mat,
            "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
          ])?.outputImage
    else { return 0 }
    let extent = clamped.extent
    guard extent.width >= 1, extent.height >= 1 else { return 0 }
    guard let avg = CIFilter(name: "CIAreaAverage") else { return 0 }
    avg.setValue(clamped, forKey: kCIInputImageKey)
    avg.setValue(CIVector(cgRect: extent), forKey: kCIInputExtentKey)
    guard let out = avg.outputImage else { return 0 }
    var bitmap = [UInt8](repeating: 0, count: 4)
    context.render(
      out,
      toBitmap: &bitmap,
      rowBytes: 4,
      bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
      format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB()
    )
    let r = CGFloat(bitmap[0]) / 255.0
    let g = CGFloat(bitmap[1]) / 255.0
    let b = CGFloat(bitmap[2]) / 255.0
    return (r + g + b) / 3.0
  }

  /// Original RGB with background forced to white using person-on-white mask as alpha.
  private func compositeOriginalOnWhite(origCrop: CIImage, maskPatch: CIImage, context: CIContext) -> CIImage? {
    let extent = origCrop.extent
    guard extent.width >= 1, extent.height >= 1 else { return nil }
    let mp = maskPatch.cropped(to: extent)
    guard let mat = CIFilter(name: "CIColorMatrix", parameters: [
      kCIInputImageKey: mp,
      "inputRVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputGVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputBVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
      "inputBiasVector": CIVector(x: 3, y: 3, z: 3, w: 0),
    ])?.outputImage,
          let clamped = CIFilter(name: "CIColorClamp", parameters: [
            kCIInputImageKey: mat,
            "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
          ])?.outputImage
    else { return nil }
    let white = CIImage(color: .white).cropped(to: extent)
    guard let blend = CIFilter(name: "CIBlendWithMask") else { return nil }
    blend.setValue(origCrop, forKey: kCIInputImageKey)
    blend.setValue(white, forKey: kCIInputBackgroundImageKey)
    blend.setValue(clamped, forKey: kCIInputMaskImageKey)
    return blend.outputImage
  }

  /// Original RGB with background forced to transparent using person-on-white mask as alpha.
  private func compositeOriginalOnTransparent(origCrop: CIImage, maskPatch: CIImage) -> CIImage? {
    let extent = origCrop.extent
    guard extent.width >= 1, extent.height >= 1 else { return nil }
    let mp = maskPatch.cropped(to: extent)
    guard let mat = CIFilter(name: "CIColorMatrix", parameters: [
      kCIInputImageKey: mp,
      "inputRVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputGVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputBVector": CIVector(x: -1, y: -1, z: -1, w: 0),
      "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
      "inputBiasVector": CIVector(x: 3, y: 3, z: 3, w: 0),
    ])?.outputImage,
          let clamped = CIFilter(name: "CIColorClamp", parameters: [
            kCIInputImageKey: mat,
            "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
          ])?.outputImage
    else { return nil }
    let clear = ciClearImage(extent: extent)
    guard let blend = CIFilter(name: "CIBlendWithMask") else { return nil }
    blend.setValue(origCrop, forKey: kCIInputImageKey)
    blend.setValue(clear, forKey: kCIInputBackgroundImageKey)
    blend.setValue(clamped, forKey: kCIInputMaskImageKey)
    return blend.outputImage
  }

  private func cropGarmentsFromOriginalOnly(originalBase64: String, boxes: [[Double]]) -> [String] {
    guard let data = Data(base64Encoded: originalBase64),
          let ui = UIImage(data: data),
          let cg = normalizedCGImage(from: ui)
    else { return [] }
    let ci = CIImage(cgImage: cg)
    let imgW = CGFloat(cg.width)
    let imgH = CGFloat(cg.height)
    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    let padding: CGFloat = 0.18
    var results: [String] = []
    for box in boxes {
      guard box.count == 4, let cropRect = cropRect(for: box, imgW: imgW, imgH: imgH, padding: padding) else { continue }
      let raw = ci.cropped(to: cropRect)
      let shifted = raw.transformed(by: CGAffineTransform(translationX: -raw.extent.origin.x, y: -raw.extent.origin.y))
      let polished = polish(image: shifted)
      if let cgOut = ciContext.createCGImage(polished, from: polished.extent),
         let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.9) {
        results.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
      }
    }
    return results
  }

  /// Mean sRGB luminance (0–1) for CIAreaAverage over full extent.
  private func meanRgbLuminance(_ image: CIImage, context: CIContext) -> CGFloat? {
    let extent = image.extent
    guard extent.width >= 1, extent.height >= 1 else { return nil }
    guard let filter = CIFilter(name: "CIAreaAverage") else { return nil }
    filter.setValue(image, forKey: kCIInputImageKey)
    filter.setValue(CIVector(cgRect: extent), forKey: kCIInputExtentKey)
    guard let output = filter.outputImage else { return nil }
    var bitmap = [UInt8](repeating: 0, count: 4)
    context.render(
      output,
      toBitmap: &bitmap,
      rowBytes: 4,
      bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
      format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB()
    )
    let r = CGFloat(bitmap[0]) / 255.0
    let g = CGFloat(bitmap[1]) / 255.0
    let b = CGFloat(bitmap[2]) / 255.0
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  /// Garment PNG: auto-trim transparent margins, then contain-fit into square so items
  /// are never clipped. Falls back to original crop when polished result is blank white.
  private func pngDataUriFromPolishedTransparentWithFallback(
    polished: CIImage,
    fallbackShiftedOrig: CIImage?,
    context: CIContext
  ) -> String? {
    let lum = self.meanRgbLuminance(polished, context: context) ?? 0
    let base: CIImage
    if let fb = fallbackShiftedOrig, lum >= 0.991 {
      base = polish(image: fb)
    } else {
      base = polished
    }
    // Normalize to (0,0) before trimming (polish can shift extent slightly)
    let norm = base.transformed(
      by: CGAffineTransform(translationX: -base.extent.origin.x, y: -base.extent.origin.y)
    )
    // Auto-trim transparent margins → tight bbox → add breathing room → contain-fit.
    // The 8% pad after trim prevents items from being flush against the square
    // edges (looked overly "zoomed in" without it).
    let trimmed: CIImage
    if let trimRect = autoTrimAlpha(norm, context: context),
       trimRect.width >= 8, trimRect.height >= 8 {
      let cropped = norm.cropped(to: trimRect)
      let tight = cropped.transformed(
        by: CGAffineTransform(translationX: -cropped.extent.origin.x, y: -cropped.extent.origin.y)
      )
      let padX = tight.extent.width * 0.08
      let padY = tight.extent.height * 0.08
      let paddedExtent = CGRect(
        x: -padX, y: -padY,
        width: tight.extent.width + padX * 2,
        height: tight.extent.height + padY * 2
      )
      let paddedBg = ciClearImage(extent: paddedExtent)
      let padded = tight.composited(over: paddedBg).cropped(to: paddedExtent)
      trimmed = padded.transformed(
        by: CGAffineTransform(translationX: -padded.extent.origin.x, y: -padded.extent.origin.y)
      )
    } else {
      trimmed = norm
    }
    // Aspect-aware canvas: tall items (h/w > 1.35) get a 1024×1382 card so
    // shirts/dresses fill vertically instead of sitting in dead space; wide
    // items (w/h > 1.35) get 1382×1024 so belts/shoes fill horizontally;
    // everything else stays square 1024². Contain-fit preserves full garment.
    let aspect = trimmed.extent.height / max(trimmed.extent.width, 1)
    let canvasW: CGFloat
    let canvasH: CGFloat
    if aspect > 1.35 {
      canvasW = kCutoutSquareSide
      canvasH = kCutoutSquareSide * 1.35
    } else if aspect < (1.0 / 1.35) {
      canvasW = kCutoutSquareSide * 1.35
      canvasH = kCutoutSquareSide
    } else {
      canvasW = kCutoutSquareSide
      canvasH = kCutoutSquareSide
    }
    let out = containFitTransparent(image: trimmed, width: canvasW, height: canvasH) ?? trimmed
    guard let cgOut = context.createCGImage(out, from: out.extent),
          let png = UIImage(cgImage: cgOut).pngData()
    else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
  }

  /// Find the tight bounding box of non-transparent pixels (alpha > 16) in a CIImage.
  /// Input must be normalized so extent starts at (0,0). Returns a CGRect in CIImage
  /// (bottom-left origin) coordinates. Returns nil if the image is entirely transparent.
  private func autoTrimAlpha(_ image: CIImage, context: CIContext) -> CGRect? {
    let W = image.extent.width
    let H = image.extent.height
    guard W >= 4, H >= 4 else { return nil }
    // Downsample aggressively — we only need bounding-box precision, not pixel accuracy.
    let targetSide: CGFloat = 256
    let scale = min(targetSide / W, targetSide / H, 1.0)
    let small = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let shifted = small.transformed(
      by: CGAffineTransform(translationX: -small.extent.origin.x, y: -small.extent.origin.y)
    )
    let sz = shifted.extent.size
    guard sz.width >= 1, sz.height >= 1,
          let cg = context.createCGImage(
            shifted, from: CGRect(origin: .zero, size: sz),
            format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()
          )
    else { return nil }
    let w = cg.width; let h = cg.height
    var bytes = [UInt8](repeating: 0, count: w * h * 4)
    guard let cgCtx = CGContext(
      data: &bytes, width: w, height: h,
      bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    cgCtx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var minX = w, maxX = -1, minY = h, maxY = -1
    for y in 0..<h {
      for x in 0..<w {
        if bytes[(y * w + x) * 4 + 3] > 16 {
          if x < minX { minX = x }
          if x > maxX { maxX = x }
          if y < minY { minY = y }
          if y > maxY { maxY = y }
        }
      }
    }
    guard maxX >= 0 else { return nil }
    let inv = 1.0 / scale
    // CGImage is top-left (row 0 = top visual). CIImage is bottom-left (y=0 = bottom visual).
    // CGImage minY (topmost non-transparent row) → CIImage high-y (near top of extent).
    // CIImage y of the bottom of the bbox = H - (maxY + 1) * inv
    let ciX = CGFloat(minX) * inv
    let ciY = H - CGFloat(maxY + 1) * inv
    let ciW = CGFloat(maxX - minX + 1) * inv
    let ciH = CGFloat(maxY - minY + 1) * inv
    return CGRect(
      x: max(0, ciX), y: max(0, ciY),
      width: min(ciW, W - max(0, ciX)),
      height: min(ciH, H - max(0, ciY))
    )
  }

  /// Scale `image` to fit **within** a square of `side`×`side` (contain fit), centered
  /// on a transparent canvas. Full garment always visible; transparent padding on short axis.
  private func squareContainFitTransparent(image: CIImage, side: CGFloat) -> CIImage? {
    let e = image.extent
    guard e.width >= 1, e.height >= 1, e.width.isFinite, e.height.isFinite, side >= 32 else { return nil }
    let scale = min(side / e.width, side / e.height)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let sw = e.width * scale
    let sh = e.height * scale
    let tx = (side - sw) / 2
    let ty = (side - sh) / 2
    let placed = scaled.transformed(by: CGAffineTransform(translationX: tx, y: ty))
    let clearSquare = ciClearImage(extent: CGRect(x: 0, y: 0, width: side, height: side))
    return placed.composited(over: clearSquare).cropped(to: CGRect(x: 0, y: 0, width: side, height: side))
  }

  /// Scale `image` to fit **within** a square of `side`×`side` (contain fit), centered
  /// on a white canvas. Used for fallback crops (opaque JPEG, no alpha). Full item visible;
  /// white padding on short axis.
  private func squareContainFitWhite(image: CIImage, side: CGFloat) -> CIImage? {
    let e = image.extent
    guard e.width >= 1, e.height >= 1, e.width.isFinite, e.height.isFinite, side >= 32 else { return nil }
    let scale = min(side / e.width, side / e.height)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let sw = e.width * scale
    let sh = e.height * scale
    let tx = (side - sw) / 2
    let ty = (side - sh) / 2
    let placed = scaled.transformed(by: CGAffineTransform(translationX: tx, y: ty))
    
    // Use warm neutral instead of pure white for letterboxing
    let bgWarm = CIImage(color: CIColor(red: 245.0/255.0, green: 241.0/255.0, blue: 236.0/255.0))
    let bgSquare = bgWarm.cropped(to: CGRect(x: 0, y: 0, width: side, height: side))
    return placed.composited(over: bgSquare).cropped(to: CGRect(x: 0, y: 0, width: side, height: side))
  }

  /// Wrong box / failed mask often yields a flat white JPEG — show original crop instead when possible.
  private func jpegDataUriFromPolishedWithBlankFallback(
    polished: CIImage,
    fallbackShiftedOrig: CIImage?,
    context: CIContext,
    quality: CGFloat
  ) -> String? {
    let lum = self.meanRgbLuminance(polished, context: context) ?? 0
    let finalPolished: CIImage
    if let fb = fallbackShiftedOrig, lum >= 0.991 {
      finalPolished = polish(image: fb)
    } else {
      finalPolished = polished
    }
    guard let cgOut = context.createCGImage(finalPolished, from: finalPolished.extent),
          let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: quality)
    else { return nil }
    return "data:image/jpeg;base64," + jpeg.base64EncodedString()
  }

  private func cropRect(for box: [Double], imgW: CGFloat, imgH: CGFloat, padding: CGFloat) -> CGRect? {
    guard box.count == 4 else { return nil }
    let ymin = CGFloat(box[0]) / 1000.0
    let xmin = CGFloat(box[1]) / 1000.0
    let ymax = CGFloat(box[2]) / 1000.0
    let xmax = CGFloat(box[3]) / 1000.0
    guard xmax > xmin, ymax > ymin else { return nil }
    let rawX = xmin * imgW
    let rawY = (1.0 - ymax) * imgH
    let rawW = (xmax - xmin) * imgW
    let rawH = (ymax - ymin) * imgH
    let padX = rawW * padding
    let padY = rawH * padding
    let cropX = max(0, rawX - padX)
    let cropY = max(0, rawY - padY)
    let cropW = min(rawW + padX * 2, imgW - cropX)
    let cropH = min(rawH + padY * 2, imgH - cropY)
    guard cropW >= 20, cropH >= 20 else { return nil }
    return CGRect(x: cropX, y: cropY, width: cropW, height: cropH)
  }

  /// True when the masked patch is ~empty (scene removed) — mean luminance very high.
  private func isMostlyEmptyMaskedCrop(_ image: CIImage, context: CIContext) -> Bool {
    guard let lum = self.meanRgbLuminance(image, context: context) else { return true }
    // Treat as “empty” only when extremely close to white.
    return lum >= 0.985
  }

  /// Writes polished JPEG to tmp and returns `file://…` for RN `<Image>`.
  private func polishJpegToTempFileUrl(plainBase64: String) -> String? {
    var payload = plainBase64
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\n", with: "")
      .replacingOccurrences(of: "\r", with: "")
    if let r = payload.range(of: "base64,", options: .caseInsensitive) {
      payload = String(payload[r.upperBound...])
    }
    guard let data = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters]),
          let ui = UIImage(data: data)
    else { return nil }
    return polishUIImageToTempFileUrl(ui)
  }

  private func polishFileUriToTempFileUrl(_ fileUri: String) -> String? {
    let trimmed = fileUri.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), url.isFileURL else { return nil }
    guard let data = try? Data(contentsOf: url), let ui = UIImage(data: data) else { return nil }
    return polishUIImageToTempFileUrl(ui)
  }

  private func polishUIImageToTempFileUrl(_ ui: UIImage) -> String? {
    guard let cg = normalizedCGImage(from: ui) else { return nil }
    let ci = CIImage(cgImage: cg)
    let polished = polishForEnhance(image: ci)
    let ctx = CIContext(options: [.useSoftwareRenderer: false])
    let extent = polished.extent
    guard extent.width.isFinite, extent.height.isFinite, extent.width > 0, extent.height > 0,
          let cgOut = ctx.createCGImage(polished, from: extent)
    else { return nil }

    let name: String
    let data: Data?
    if cgImageHasAlpha(cgOut) {
      name = "ootd-polish-\(UUID().uuidString).png"
      data = UIImage(cgImage: cgOut).pngData()
    } else {
      name = "ootd-polish-\(UUID().uuidString).jpg"
      data = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.9)
    }
    guard let outData = data else { return nil }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
    do {
      try outData.write(to: url, options: .atomic)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  /// Slightly stronger than thumbnail polish so Enhance is visibly different.
  private func polishForEnhance(image: CIImage) -> CIImage {
    var result = image
    let sharpen = CIFilter.unsharpMask()
    sharpen.inputImage = result
    sharpen.radius = 1.4
    sharpen.intensity = 0.16
    if let out = sharpen.outputImage { result = out }
    let colorCtrl = CIFilter.colorControls()
    colorCtrl.inputImage = result
    colorCtrl.brightness = 0.0
    colorCtrl.contrast = 1.02
    colorCtrl.saturation = 1.0
    if let out = colorCtrl.outputImage { result = out }
    return result
  }

  // ── Polish: unsharp mask + contrast/saturation boost ─────────────────────

  private func polish(image: CIImage) -> CIImage {
    var result = image

    let sharpen = CIFilter.unsharpMask()
    sharpen.inputImage = result
    sharpen.radius = 1.8
    sharpen.intensity = 0.28
    if let out = sharpen.outputImage { result = out }

    let colorCtrl = CIFilter.colorControls()
    colorCtrl.inputImage = result
    colorCtrl.brightness = 0.01
    colorCtrl.contrast = 1.04
    colorCtrl.saturation = 1.02
    if let out = colorCtrl.outputImage { result = out }

    return result
  }

  // ── Orientation normalisation ──────────────────────────────────────────────

  private func normalizedCGImage(from image: UIImage) -> CGImage? {
    if image.imageOrientation == .up { return image.cgImage }
    let size = image.size
    UIGraphicsBeginImageContextWithOptions(size, false, image.scale)
    defer { UIGraphicsEndImageContext() }
    image.draw(in: CGRect(origin: .zero, size: size))
    return UIGraphicsGetImageFromCurrentImageContext()?.cgImage
  }
}
