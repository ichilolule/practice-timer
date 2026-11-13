import AppKit

let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
for size in [16, 32] {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let scale = CGFloat(size) / 16
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.concat()
    NSColor.black.setStroke()
    let circle = NSBezierPath(ovalIn: NSRect(x: 2.5, y: 1, width: 11, height: 11))
    circle.lineWidth = 1.5
    circle.stroke()
    let hands = NSBezierPath()
    hands.lineWidth = 1.5
    hands.lineCapStyle = .round
    hands.move(to: NSPoint(x: 8, y: 6.5)); hands.line(to: NSPoint(x: 8, y: 10))
    hands.move(to: NSPoint(x: 6, y: 14)); hands.line(to: NSPoint(x: 10, y: 14))
    hands.move(to: NSPoint(x: 8, y: 12)); hands.line(to: NSPoint(x: 8, y: 14))
    hands.move(to: NSPoint(x: 12.5, y: 11)); hands.line(to: NSPoint(x: 14, y: 12.5))
    hands.stroke()
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(size == 16 ? "trayTemplate.png" : "trayTemplate@2x.png"))
}
