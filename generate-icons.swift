import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let sourceURL = folder.appendingPathComponent("icon-source.png")
// Trim equal amounts of the peach border; the stopwatch itself remains intact.
guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      image.width == 1254, image.height == 1254,
      let cropped = image.cropping(to: CGRect(x: 59, y: 59, width: 1136, height: 1136)) else {
    fatalError("Expected a 1254px square icon source")
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue

func writeIcon(_ filename: String, size: Int, artworkSize: Int, roundCorners: Bool) {
    guard let context = CGContext(data: nil, width: size, height: size,
                                  bitsPerComponent: 8, bytesPerRow: 0,
                                  space: colorSpace, bitmapInfo: bitmapInfo) else {
        fatalError("Could not create bitmap")
    }
    context.interpolationQuality = .high
    context.setAllowsAntialiasing(true)
    let inset = CGFloat(size - artworkSize) / 2
    let rect = CGRect(x: inset, y: inset, width: CGFloat(artworkSize), height: CGFloat(artworkSize))
    if roundCorners {
        let radius = CGFloat(artworkSize) * 0.21
        context.addPath(CGPath(roundedRect: rect, cornerWidth: radius,
                               cornerHeight: radius, transform: nil))
        context.clip()
    }
    context.draw(cropped, in: rect)
    guard let icon = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(
            folder.appendingPathComponent(filename) as CFURL,
            UTType.png.identifier as CFString, 1, nil
          ) else {
        fatalError("Could not render \(filename)")
    }
    CGImageDestinationAddImage(destination, icon, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("Could not save \(filename)")
    }
}

writeIcon("favicon-32.png", size: 32, artworkSize: 32, roundCorners: false)
writeIcon("apple-touch-icon.png", size: 180, artworkSize: 180, roundCorners: false)
// Dock artwork fills 81.25% of the canvas, leaving transparent outer margins.
writeIcon("stopwatch-dock-icon-192.png", size: 192, artworkSize: 156, roundCorners: true)
writeIcon("stopwatch-dock-icon-512.png", size: 512, artworkSize: 416, roundCorners: true)
