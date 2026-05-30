// macOS Vision OCR CLI：参数为若干图片路径，逐张识别，页间打印分隔符。
// 中文技术扫描件用 zh-Hans + en-US，accurate 级别 + 语言纠正。
import Foundation
import Vision
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty { FileHandle.standardError.write("usage: vision-ocr <img>...\n".data(using:.utf8)!); exit(1) }

func ocr(_ path: String) -> String {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ""
    }
    var lines: [String] = []
    let req = VNRecognizeTextRequest { (request, _) in
        guard let obs = request.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            if let top = o.topCandidates(1).first { lines.append(top.string) }
        }
    }
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    return lines.joined(separator: "\n")
}

for (i, p) in args.enumerated() {
    if i > 0 { print("<<<PAGE_BREAK>>>") }
    print(ocr(p))
}
