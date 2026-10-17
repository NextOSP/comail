// C-ABI bridge from comail-core (Rust) to Apple's on-device Foundation
// Models (Apple Intelligence). Compiled into a static library by build.rs
// whenever the macOS SDK ships FoundationModels; every entry point checks
// availability at runtime so the binary still launches on older macOS and on
// Intel Macs (the framework is weak-linked and simply reports "unsupported").

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// `kind` values passed to the callback. Exactly one terminal kind (>= 1) is
/// delivered per request; `COMAIL_FM_DELTA` may precede it any number of times.
private let COMAIL_FM_DELTA: Int32 = 0
private let COMAIL_FM_DONE: Int32 = 1
private let COMAIL_FM_ERROR: Int32 = 2
private let COMAIL_FM_CONTEXT_EXCEEDED: Int32 = 3
private let COMAIL_FM_GUARDRAIL: Int32 = 4
private let COMAIL_FM_UNSUPPORTED_LANGUAGE: Int32 = 5

public typealias ComailFMCallback = @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?) -> Void

/// Opaque Rust context pointer, only ever handed back to the callback.
private struct ContextBox: @unchecked Sendable {
    let raw: UnsafeMutableRawPointer?
}

private func emit(_ cb: ComailFMCallback, _ ctx: ContextBox, _ kind: Int32, _ text: String) {
    text.withCString { cb(ctx.raw, kind, $0) }
}

/// 0 available, 1 device not eligible (e.g. Intel Mac), 2 Apple Intelligence
/// turned off, 3 model still downloading, 4 macOS older than 26, 9 unknown.
@_cdecl("comail_fm_availability")
public func comail_fm_availability() -> Int32 {
#if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
            return 0
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: return 1
            case .appleIntelligenceNotEnabled: return 2
            case .modelNotReady: return 3
            @unknown default: return 9
            }
        }
    }
#endif
    return 4
}

/// Run one generation. `instructions` holds trusted system text; `prompt` the
/// user turn (including any untrusted email content). With `stream` != 0 the
/// callback receives incremental answer text as it's produced. The callback
/// may fire on any thread, after this function has returned.
@_cdecl("comail_fm_respond")
public func comail_fm_respond(
    _ instructions: UnsafePointer<CChar>,
    _ prompt: UnsafePointer<CChar>,
    _ stream: Int32,
    _ ctx: UnsafeMutableRawPointer?,
    _ cb: ComailFMCallback
) {
    let box = ContextBox(raw: ctx)
    let instructions = String(cString: instructions)
    let prompt = String(cString: prompt)
#if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        Task.detached {
            await respond(instructions: instructions, prompt: prompt, stream: stream != 0, ctx: box, cb: cb)
        }
        return
    }
#endif
    emit(cb, box, COMAIL_FM_ERROR, "Apple Intelligence requires macOS 26 or later")
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private func respond(
    instructions: String,
    prompt: String,
    stream: Bool,
    ctx: ContextBox,
    cb: ComailFMCallback
) async {
    // Mail is full of content the default guardrails over-flag when merely
    // summarized or replied to; the permissive mode still blocks harmful output.
    let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
    let session = instructions.isEmpty
        ? LanguageModelSession(model: model)
        : LanguageModelSession(model: model, instructions: instructions)
    do {
        if stream {
            // Snapshots carry the cumulative text; forward only what's new.
            var sent = ""
            for try await snapshot in session.streamResponse(to: prompt) {
                let full = snapshot.content
                if full.hasPrefix(sent) {
                    let delta = String(full.dropFirst(sent.count))
                    if !delta.isEmpty { emit(cb, ctx, COMAIL_FM_DELTA, delta) }
                }
                sent = full
            }
            emit(cb, ctx, COMAIL_FM_DONE, sent)
        } else {
            let response = try await session.respond(to: prompt)
            emit(cb, ctx, COMAIL_FM_DONE, response.content)
        }
    } catch let error as LanguageModelSession.GenerationError {
        switch error {
        case .exceededContextWindowSize:
            emit(cb, ctx, COMAIL_FM_CONTEXT_EXCEEDED, error.localizedDescription)
        case .guardrailViolation, .refusal:
            emit(cb, ctx, COMAIL_FM_GUARDRAIL, error.localizedDescription)
        case .unsupportedLanguageOrLocale:
            emit(cb, ctx, COMAIL_FM_UNSUPPORTED_LANGUAGE, error.localizedDescription)
        default:
            emit(cb, ctx, COMAIL_FM_ERROR, error.localizedDescription)
        }
    } catch {
        emit(cb, ctx, COMAIL_FM_ERROR, error.localizedDescription)
    }
}
#endif
