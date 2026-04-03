import ExpoModulesCore
import CoreImage
import UIKit
import Vision

// ──────────────────────────────────────────────────────────────────────────────
// ClothingIsolatorModule
//
// Wraps Apple's Vision framework to remove photo backgrounds on-device.
//
// iOS 17+  →  VNGenerateForegroundInstanceMaskRequest
//             Pixel-perfect RGBA mask for any salient foreground subject
//             (worn clothing AND flat-lay items on a surface). ~200-400 ms.
//
// iOS <17  →  returns nil; JS side falls back to Gemini cloud pipeline.
// ──────────────────────────────────────────────────────────────────────────────

public class ClothingIsolatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClothingIsolator")

    // Async bridge function called from JS.
    // Runs entirely on a background thread so the UI thread is never blocked.
    AsyncFunction("isolateClothing") { (base64Jpeg: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let result = try self.performIsolation(base64: base64Jpeg)
          promise.resolve(result)
        } catch {
          // Surface the error message so the JS catch block can log it if needed.
          promise.reject("ISOLATION_FAILED", error.localizedDescription)
        }
      }
    }
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  private func performIsolation(base64: String) throws -> String? {
    guard let data = Data(base64Encoded: base64) else {
      throw NSError(
        domain: "ClothingIsolator",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid base64 input"]
      )
    }
    guard let uiImage = UIImage(data: data) else {
      throw NSError(
        domain: "ClothingIsolator",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Cannot decode image data"]
      )
    }
    // Normalise orientation so Vision sees an upright image.
    guard let cgImage = normalizedCGImage(from: uiImage) else {
      throw NSError(
        domain: "ClothingIsolator",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Cannot render normalised CGImage"]
      )
    }

    if #available(iOS 17.0, *) {
      return try isolateWithForegroundMask(cgImage: cgImage)
    }
    // iOS < 17: no built-in foreground instance API; signal JS to use Gemini.
    return nil
  }

  // ── iOS 17+ Vision path ────────────────────────────────────────────────────

  @available(iOS 17.0, *)
  private func isolateWithForegroundMask(cgImage: CGImage) throws -> String? {
    // A single VNImageRequestHandler must be used for both the request AND the
    // masked-image generation step — Vision reuses the decoded image buffer.
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()

    try handler.perform([request])

    guard let observation = request.results?.first as? VNInstanceMaskObservation,
          !observation.allInstances.isEmpty
    else {
      return nil
    }

    // Generate a full-resolution RGBA pixel buffer with the background zeroed out.
    let maskedBuffer = try observation.generateMaskedImage(
      ofInstances: observation.allInstances,
      from: handler,
      croppedToInstancesExtent: false
    )

    return compositeOnWhite(maskedBuffer: maskedBuffer, sourceSize: cgImage.size)
  }

  // ── Composite RGBA buffer onto white ──────────────────────────────────────

  @available(iOS 17.0, *)
  private func compositeOnWhite(maskedBuffer: CVPixelBuffer, sourceSize: CGSize) -> String? {
    // Prefer the Metal/GPU context when available for speed.
    let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    let maskedCI = CIImage(cvPixelBuffer: maskedBuffer)
    // Solid white canvas sized exactly to the masked image.
    let white = CIImage(color: CIColor.white).cropped(to: maskedCI.extent)

    // Alpha-composite: item pixels over white. Background alpha=0 → pure white.
    let composited = maskedCI.composited(over: white)

    guard let cgOut = ciContext.createCGImage(composited, from: composited.extent) else {
      return nil
    }

    let outImage = UIImage(cgImage: cgOut)

    // JPEG at 93% — good visual quality, smaller payload than PNG.
    guard let jpegData = outImage.jpegData(compressionQuality: 0.93) else {
      return nil
    }

    return "data:image/jpeg;base64," + jpegData.base64EncodedString()
  }

  // ── Orientation normalisation ──────────────────────────────────────────────

  /// Re-draws UIImage into a CGContext so the resulting CGImage is always
  /// oriented correctly (imageOrientation == .up).  Vision and CoreImage both
  /// work on raw pixel data; without this step a landscape or rotated capture
  /// from the Camera roll would produce a misaligned mask.
  private func normalizedCGImage(from image: UIImage) -> CGImage? {
    if image.imageOrientation == .up {
      return image.cgImage
    }
    let size = image.size
    UIGraphicsBeginImageContextWithOptions(size, false, image.scale)
    defer { UIGraphicsEndImageContext() }
    image.draw(in: CGRect(origin: .zero, size: size))
    return UIGraphicsGetImageFromCurrentImageContext()?.cgImage
  }
}

// ── CGSize convenience ────────────────────────────────────────────────────────

private extension CGImage {
  var size: CGSize { CGSize(width: width, height: height) }
}
