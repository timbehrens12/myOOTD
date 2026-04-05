import ExpoModulesCore
import CoreImage
import UIKit
import Vision

// ──────────────────────────────────────────────────────────────────────────────
// ClothingIsolatorModule
//
// iOS 17+  →  VNGenerateForegroundInstanceMaskRequest
//             Returns one white-background JPEG per detected foreground instance
//             (i.e. one image per garment/accessory). ~300-600 ms total.
//
// iOS <17  →  returns empty array; JS falls back to full-photo cloud pipeline.
// ──────────────────────────────────────────────────────────────────────────────

public class ClothingIsolatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClothingIsolator")

    // Returns an array of base64 data URIs — one per segmented item.
    // Empty array means no instances found or iOS < 17 (JS should fall back).
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
  }

  // ── Entry point ────────────────────────────────────────────────────────────

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
    var results: [String] = []

    // If there's only one instance, return the full-frame masked image
    // (likely a person wearing clothes — AI will split via box_2d later)
    if observation.allInstances.count == 1 {
      let maskedBuffer = try observation.generateMaskedImage(
        ofInstances: observation.allInstances,
        from: handler,
        croppedToInstancesExtent: false
      )
      let maskedCI = CIImage(cvPixelBuffer: maskedBuffer)
      let white = CIImage(color: .white).cropped(to: maskedCI.extent)
      let composited = maskedCI.composited(over: white)

      if let cgOut = ciContext.createCGImage(composited, from: composited.extent),
         let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.92) {
        results.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
      }
      return results
    }

    // Multiple instances → one tight-cropped white-bg JPEG per item
    for instance in observation.allInstances {
      do {
        let maskedBuffer = try observation.generateMaskedImage(
          ofInstances: IndexSet(integer: Int(instance)),
          from: handler,
          croppedToInstancesExtent: true
        )

        let maskedCI = CIImage(cvPixelBuffer: maskedBuffer)
        let white = CIImage(color: .white).cropped(to: maskedCI.extent)
        let composited = maskedCI.composited(over: white)

        if let cgOut = ciContext.createCGImage(composited, from: composited.extent),
           let jpeg = UIImage(cgImage: cgOut).jpegData(compressionQuality: 0.92) {
          results.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
      } catch {
        continue
      }
    }

    return results
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
