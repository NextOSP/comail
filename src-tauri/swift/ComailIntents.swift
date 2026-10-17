// Siri, Shortcuts and Spotlight actions (App Intents) for Comail.
//
// Compiled into a static library by build.rs, which also runs Apple's
// appintentsmetadataprocessor to produce the Metadata.appintents bundle the
// system reads from Comail.app/Contents/Resources. Each intent forwards a small
// JSON request to Rust (`apple_intents.rs`) through the handler installed with
// `comail_intents_install`, and speaks/returns the reply.

import AppIntents
import Foundation

public typealias ComailIntentReply = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void
public typealias ComailIntentHandler = @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?, ComailIntentReply) -> Void

private var rustHandler: ComailIntentHandler?

@_cdecl("comail_intents_install")
public func comail_intents_install(_ handler: ComailIntentHandler) {
    rustHandler = handler
    if #available(macOS 14.0, *) {
        ComailShortcuts.updateAppShortcutParameters()
    }
}

private final class ReplyBox {
    let resume: (String) -> Void
    init(_ resume: @escaping (String) -> Void) { self.resume = resume }
}

/// Called by Rust exactly once per request, on any thread.
private let replyTrampoline: ComailIntentReply = { ctx, json in
    guard let ctx else { return }
    let box = Unmanaged<ReplyBox>.fromOpaque(ctx).takeRetainedValue()
    box.resume(json.map { String(cString: $0) } ?? "{}")
}

private struct RustReply {
    var ok = false
    var dialog = "Comail couldn't do that right now."
    var value = ""
    var number = 0
}

@available(macOS 13.0, *)
private func callRust(_ request: [String: String]) async -> RustReply {
    guard let handler = rustHandler,
          let data = try? JSONSerialization.data(withJSONObject: request),
          let json = String(data: data, encoding: .utf8)
    else {
        return RustReply(dialog: "Comail is still starting up. Try again in a moment.")
    }
    let raw: String = await withCheckedContinuation { cont in
        let box = Unmanaged.passRetained(ReplyBox { cont.resume(returning: $0) }).toOpaque()
        json.withCString { handler($0, box, replyTrampoline) }
    }
    guard let obj = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] else {
        return RustReply()
    }
    var reply = RustReply()
    reply.ok = obj["ok"] as? Bool ?? false
    if let dialog = obj["dialog"] as? String { reply.dialog = dialog }
    reply.value = obj["value"] as? String ?? ""
    reply.number = obj["number"] as? Int ?? 0
    return reply
}

// MARK: - Intents

@available(macOS 13.0, *)
struct GetVerificationCodeIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Latest Verification Code"
    static let description = IntentDescription(
        "Finds the newest one-time code in email from the last 30 minutes and copies it to the clipboard, which Universal Clipboard shares with your iPhone and iPad."
    )

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = await callRust(["action": "verificationCode"])
        return .result(value: reply.value, dialog: "\(reply.dialog)")
    }
}

@available(macOS 13.0, *)
struct CheckUnreadMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Unread Mail"
    static let description = IntentDescription("Tells you how many unread important emails you have and who they're from.")

    func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
        let reply = await callRust(["action": "unread"])
        return .result(value: reply.number, dialog: "\(reply.dialog)")
    }
}

@available(macOS 13.0, *)
struct CatchUpOnMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Catch Up on Mail"
    static let description = IntentDescription("A short spoken briefing of your unread important email, written by your AI provider.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = await callRust(["action": "catchUp"])
        return .result(value: reply.value, dialog: "\(reply.dialog)")
    }
}

@available(macOS 13.0, *)
struct AskMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask About My Email"
    static let description = IntentDescription("Answers a question using your mailbox, like Ask in Comail's search.")

    @Parameter(title: "Question", requestValueDialog: "What do you want to know about your email?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Comail \(\.$question)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = await callRust(["action": "ask", "question": question])
        return .result(value: reply.value, dialog: "\(reply.dialog)")
    }
}

@available(macOS 13.0, *)
struct ComposeEmailIntent: AppIntent {
    static let title: LocalizedStringResource = "Compose Email"
    static let description = IntentDescription("Opens a new email in Comail, optionally filled in.")
    static let openAppWhenRun = true

    @Parameter(title: "To")
    var to: String?

    @Parameter(title: "Subject")
    var subject: String?

    @Parameter(title: "Body", inputOptions: String.IntentInputOptions(multiline: true))
    var body: String?

    static var parameterSummary: some ParameterSummary {
        Summary("New email to \(\.$to)") {
            \.$subject
            \.$body
        }
    }

    func perform() async throws -> some IntentResult {
        _ = await callRust([
            "action": "compose",
            "to": to ?? "",
            "subject": subject ?? "",
            "body": body ?? "",
        ])
        return .result()
    }
}

@available(macOS 13.0, *)
struct SearchMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Search Mail"
    static let description = IntentDescription("Opens Comail's search with your query.")
    static let openAppWhenRun = true

    @Parameter(title: "Query", requestValueDialog: "What should I search for?")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("Search Comail for \(\.$query)")
    }

    func perform() async throws -> some IntentResult {
        _ = await callRust(["action": "search", "query": query])
        return .result()
    }
}

// MARK: - Siri phrases (work without any setup in Shortcuts)

@available(macOS 14.0, *)
struct ComailShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetVerificationCodeIntent(),
            phrases: [
                "Get my verification code from \(.applicationName)",
                "Copy my \(.applicationName) code",
                "What's my code in \(.applicationName)",
            ],
            shortTitle: "Verification Code",
            systemImageName: "number.square"
        )
        AppShortcut(
            intent: CheckUnreadMailIntent(),
            phrases: [
                "Check my mail in \(.applicationName)",
                "Any new email in \(.applicationName)",
                "How many unread emails in \(.applicationName)",
            ],
            shortTitle: "Unread Mail",
            systemImageName: "envelope.badge"
        )
        AppShortcut(
            intent: CatchUpOnMailIntent(),
            phrases: [
                "Catch me up with \(.applicationName)",
                "Summarize my email in \(.applicationName)",
                "What did I miss in \(.applicationName)",
            ],
            shortTitle: "Catch Up",
            systemImageName: "text.bubble"
        )
        AppShortcut(
            intent: AskMailIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) about my email",
            ],
            shortTitle: "Ask Mail",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: ComposeEmailIntent(),
            phrases: [
                "Compose an email in \(.applicationName)",
                "New email in \(.applicationName)",
            ],
            shortTitle: "Compose",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: SearchMailIntent(),
            phrases: [
                "Search \(.applicationName)",
                "Search my email in \(.applicationName)",
            ],
            shortTitle: "Search Mail",
            systemImageName: "magnifyingglass"
        )
    }
}
