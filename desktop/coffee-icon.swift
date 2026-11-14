import AppKit

let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
for size in [16, 32] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill(using: .copy)
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(size) / 16)
    transform.concat()
    NSColor.black.setStroke()
    let cup = NSBezierPath()
    cup.lineWidth = 1.25
    cup.lineJoinStyle = .round
    cup.move(to: NSPoint(x: 2, y: 10))
    cup.line(to: NSPoint(x: 11, y: 10))
    cup.line(to: NSPoint(x: 10.5, y: 5.5))
    cup.curve(to: NSPoint(x: 8.5, y: 3.5), controlPoint1: NSPoint(x: 10.4, y: 4.2), controlPoint2: NSPoint(x: 9.5, y: 3.5))
    cup.line(to: NSPoint(x: 4.5, y: 3.5))
    cup.curve(to: NSPoint(x: 2.5, y: 5.5), controlPoint1: NSPoint(x: 3.5, y: 3.5), controlPoint2: NSPoint(x: 2.6, y: 4.2))
    cup.close()
    cup.stroke()
    let detail = NSBezierPath()
    detail.lineWidth = 1.25
    detail.lineCapStyle = .round
    detail.move(to: NSPoint(x: 11, y: 9))
    detail.curve(to: NSPoint(x: 11, y: 5.5), controlPoint1: NSPoint(x: 15, y: 10), controlPoint2: NSPoint(x: 15, y: 5))
    detail.move(to: NSPoint(x: 1.5, y: 1.5)); detail.line(to: NSPoint(x: 12, y: 1.5))
    for x in [5.0, 8.0] {
        detail.move(to: NSPoint(x: x, y: 12))
        detail.curve(to: NSPoint(x: x, y: 14.5), controlPoint1: NSPoint(x: x - 1, y: 13), controlPoint2: NSPoint(x: x + 1, y: 13.5))
    }
    detail.stroke()
    NSGraphicsContext.restoreGraphicsState()
    bitmap.size = NSSize(width: 16, height: 16)
    try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(size == 16 ? "breakTrayTemplate.png" : "breakTrayTemplate@2x.png"))
}
