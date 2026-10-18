# Changelog

All notable changes to Comail are listed here. Releases follow
[semantic versioning](https://semver.org/), and the format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Installers for every release are on the
[releases page](https://github.com/NextOSP/comail/releases).

## [Unreleased]

## [0.2.36] - 2026-10-18

### Fixed

- Comail no longer stays stuck on "Offline" after the Mac wakes from a long
  sleep. Signing back in to the mail server now gives up after 30 seconds
  instead of waiting forever on a dead connection, and switching back to the
  Comail window while it shows Offline makes it reconnect right away.
- When the AI search filter fails because the AI provider rejected your API
  key, the error says so and offers an "Open AI settings" button.
- The search bar no longer jumps sideways while you type: the loading spinner,
  AI filter button and result count keep fixed places.

## [0.2.35] - 2026-10-18

### Added

- **AI filter in search.** Describe the mail you want in plain words ("all
  email from hoang with subject software update") and press `Cmd/Ctrl+O`. The
  search box fills with the real filter, using your contacts' actual
  addresses. If a name fits several people, Comail asks which one: pick with
  `1`-`9` or a click, or type an answer.
- **Keyboard navigation in the mailbox menu.** The hamburger menu takes focus
  when it opens. `Up`/`Down` (or `J`/`K`) move through it, `Enter` opens a
  row, and `Right`/`Left` expand and collapse folders.

### Changed

- **Ask AI reads more before answering.** It can open whole conversations
  (including bodies that haven't downloaded yet), streams its answer as it
  writes, and no longer shows "Let me search..." filler as the answer.

### Fixed

- The Avatar inbox layout shows the hamburger menu icon again, instead of a
  home icon.
- The composer footer no longer wraps the shortcut hint and "Draft saved"
  onto several lines when space is tight.
- A new search puts the highlight back on the first result.

## [0.2.34] - 2026-10-18

### Fixed

- **macOS builds are back.** The macOS builds of v0.2.31, v0.2.32 and v0.2.33
  failed while compiling the new app icon, so those releases shipped only
  Windows and Linux installers and Macs were not offered the update. The icon
  is now compiled ahead of the build. This release includes the macOS `.dmg`
  and the auto-update, with everything from v0.2.31 to v0.2.33.

## [0.2.33] - 2026-10-18

### Changed

- Release pipeline change only (a first attempt at the macOS build fix). Its
  macOS build still failed, so it shipped Windows and Linux installers only.

## [0.2.32] - 2026-10-18

### Added

- **Discard a draft any time.** The composer has a Discard button and a
  `Cmd/Ctrl+Shift+Backspace` shortcut, so a saved draft can be thrown away even
  without unsaved edits.
- **Delete draft** button on draft cards in a conversation.

### Fixed

- Trash in the Drafts view deletes only the drafts. The thread they reply to
  stays where it is instead of going to Trash with them.
- The From picker and other native dropdowns are readable on Windows and Linux
  (options use the theme's own colors instead of near-white text on white).

## [0.2.31] - 2026-10-18

### Added

- **AI clients over MCP.** Comail can serve a local MCP endpoint
  (`127.0.0.1` only, with a bearer token) so Claude Code, Claude Desktop,
  ChatGPT, Cursor, VS Code, Windsurf, Codex, Gemini CLI, Zed, LM Studio and
  other MCP clients can search, read and draft mail. Settings > AI clients
  (MCP) adds Comail to each app in one click or gives you a config to paste.
  Organizing and sending are separate permissions, both off by default, and
  recent tool calls are shown.

- **Decision models.** AI categories and the AI checks in rules and splits can
  go to a decision model that returns typed answers (yes/no with a confidence
  score, or one pick from a list) instead of chat text. Supported providers are
  TypeSafe Jev through OpenRouter, OpenAI's Decisions API, and any compatible
  endpoint. You can add backup providers, which are tried in order. Answers
  below a minimum confidence (60% by default) count as "no". If every provider
  fails, Comail falls back to the chat model, and with no AI at all, conditions
  and built-in sorting keep working. Set it up in Settings > AI > Decision
  model, where a Test button checks each provider.
- **Rules with conditions and AI checks.** A new rules editor matches on
  sender, recipient, subject, label, automated mail, and attachments, combined
  with AND / OR / NOT, plus an optional yes/no AI check. The AI is only asked
  about mail that passes the condition. Split inbox tabs can use AI checks
  too, and "Run automations" re-applies everything to existing mail.
- **Avatar inbox.** A second inbox style, alongside the classic dense list,
  with taller rows and sender pictures. You choose between them by clicking a
  preview in Settings. Each sender's picture is looked up once (Gravatar, then
  the company's BIMI brand logo, then the site icon), cached on disk, and can be
  turned off. Webmail domains never show the provider's logo.
- **Bundles.** In the avatar inbox, the tabs other than Important collapse
  into single rows that preview their newest senders.
- **Inbox layout options:** show or hide the bundles above Important mail,
  and turn the Today / Yesterday date headers on or off.
- **Accent color and fonts.** Pick an accent color and a typeface from a
  curated set or any Google Font.
- **"New mail" dots on inbox tabs** for tabs that got mail since you last
  looked at them.
- **Verification codes.** One-time codes ("Your code is 482913") are detected
  in incoming mail. They appear in the notification and can be copied to the
  clipboard automatically; on a Mac, Universal Clipboard makes them pasteable
  on your iPhone. Prices, phone numbers, dates, and order numbers are ignored.
- **Apple Intelligence (macOS 26+, Apple silicon).** Choose Apple's on-device
  model as the AI provider. It needs no API key, costs nothing, works offline,
  and keeps everything on your Mac. Settings tells you why it's unavailable when
  it is (wrong hardware, Apple Intelligence turned off, model still
  downloading, or an older macOS).
- **Siri and Shortcuts (macOS).** Six actions: Get Latest Verification Code,
  Check Unread Mail, Catch Up on Mail, Ask About My Email, Compose Email, and
  Search Mail.
- **Calendar day view and sidebar.** A Day view next to Week and Month, a
  time grid with a live "now" line, a mini month for jumping between dates,
  per-calendar visibility toggles, and a popover listing every event on busy
  days.
- **Better attachment viewer.** Dedicated viewers for PDF, images, Word,
  spreadsheets, slides, and plain text, with thumbnails.
- **Search learns from you.** Threads and senders you open from search results
  rank higher next time. This history stays on your device and you can clear
  it in Settings.
- **Tips bar.** A dismissible strip that teaches the core shortcuts
  (done, snooze, compose, search, command palette).
- **Signature preview** in the signature editor.
- A `search_eval` example for testing search ranking offline against a copy of
  a real mailbox.

### Changed

- A new onboarding flow (connect an account, sync, personalize, learn the
  shortcuts) replaces the cinematic first-run intro.
- New app icon.
- The macOS `.dmg` opens to a branded window that shows where to drag Comail.

- The Settings layout has been reorganized into grouped sections (Appearance,
  Notifications, Reading & sending, Models & provider, Advanced), and each page
  now has a one-line description.
- New shared UI components (buttons, fields, menus, modals, icons) give screens
  a more consistent look.
- Contact autocomplete now ranks the people you email most at the top.
  Recipients of mail sent from Comail were never counted, and a migration
  recounts them from the mail you've already sent.

### Fixed

- Inline images in sent mail (pasted screenshots, signature logos) now go in a
  proper `multipart/related` part, so Gmail, Apple Mail, and Outlook display
  them instead of showing a broken image or an extra attachment.
- Switching signatures on a saved draft replaces the old signature instead of
  adding a second one.
- If a screen crashes while rendering, Comail now shows a recovery card instead
  of a blank window.

## [0.2.30] - 2026-09-02

### Added

- Create a split rule directly from an email message.

### Fixed

- `U` / `Cmd+U` no longer says "No unsubscribe link" for threads that
  aren't open, or for mail synced before v0.2.27.
- Toasts have been restyled.

## [0.2.29] - 2026-08-06

### Added

- Comail remembers the window's size and position.
- A first-day-of-week setting.
- Formatting shortcuts in compose, plus a Clear formatting command.

### Fixed

- Exchange IMAP authentication glitches are now retried.

## [0.2.28] - 2026-08-02

### Changed

- Account markers are now colored dots, and you can turn them on or off.
- Each account can have its own color and short name, picked by default from a
  curated palette.

## [0.2.27] - 2026-08-02

### Added

- One-click unsubscribe (RFC 8058), and unsubscribe for `mailto:` links, which
  sends the email for you.
- An unsubscribe button in the thread view.

### Changed

- Unsubscribe toasts now say what actually happened.

## [0.2.26] - 2026-08-02

### Added

- A banner when an account needs to sign in again.
- Account markers in the inbox.
- Calendar colors and local calendars.
- Split exclusions.

## [0.2.25] - 2026-07-21

### Added

- Attach files by clicking to choose them or dragging them into compose.

## [0.2.24] - 2026-07-20

### Changed

- You can delete any calendar event, including ones you didn't organize.

## [0.2.23] - 2026-07-20

### Fixed

- Deleted recurring calendar series no longer come back.
- Error toasts show the real reason.

## [0.2.22] - 2026-07-17

### Fixed

- Keyboard shortcuts keep working after clicking inside an email.
- Opening a thread scrolls reliably.
- The send chime is quieter.

## [0.2.21] - 2026-07-17

### Added

- A search operator guide that covers dates and sorting.
- Ask can be limited to one account.

### Fixed

- Scrolling after auto-advance.

## [0.2.20] - 2026-07-16

### Added

- A warning when a send is stuck waiting for you to sign in again.
- A Compose button.

## [0.2.19] - 2026-07-16

### Added

- Activity heatmaps.
- Guidance for setting up Google Calendar.
- A Gmail-style select-all toggle.

## [0.2.18] - 2026-07-16

### Added

- AI thread summaries now stream in and suggest calendar events.
- An email activity dashboard.
- Contact autocomplete per account.

## [0.2.17] - 2026-07-15

### Added

- @-mentions in compose.
- Start and end times for calendar events.

### Fixed

- Quoting of text in Unicode NFD form.

## [0.2.16] - 2026-07-15

### Added

- Local AI usage tracking that records model, scenario, and token counts only,
  never prompts or responses.
- AI automations can add a subject prefix or a note that only you see. The
  original message is never modified.
- Custom splits and auto-label tabs share one ordering that you can rearrange.

### Fixed

- Signature logos that only declare a height no longer stretch to full width.
- Settings panels show a single, tidy scrollbar.

## [0.2.15] - 2026-07-15

### Added

- Hybrid inbox routing: each email lands in exactly one tab. Your rules run
  first, then an optional AI classifier, then the built-in
  Marketing/News/Social/Pitch heuristics, then Important or Other.
- Split rules can route to any tab, match on To/Cc and attachments, and be
  dragged to reorder (priority numbers are shown).
- "Sort mail into categories" with AI, with decisions cached by sender.
- Auto categories can be deleted individually.

### Fixed

- Automated mail no longer shows up in both Other and its category.
- RFC 2047-encoded attachment filenames are decoded.

## [0.2.14] - 2026-07-14

### Added

- Two-way Microsoft 365 calendar sync through Microsoft Graph.
- Per-account themes, and a new Holiday theme.
- One-click AI signature generation.

## [0.2.13] - 2026-07-14

### Added

- A right-click menu on thread rows that works on the current selection.
- The left and right arrow keys move between threads, like `J` and `K`.

## [0.2.12] - 2026-07-14

### Fixed

- Remote images served over plain HTTP load by upgrading to HTTPS.
- Opening a thread scrolls to the first unread message.

## [0.2.11] - 2026-07-14

### Fixed

- Large Microsoft refresh tokens are split into chunks so they fit in Windows
  secure storage.
- Text in HTML emails, such as one-time codes, can be selected and copied.

## [0.2.10] - 2026-07-14

### Added

- In-app update downloads with live progress.
- The command palette can jump to folders and search mail, and runs the AI
  action for queries that start with a verb.
- Calendar quick-create recognizes online meetings and creates real Teams
  meetings.
- `subject:` and `body:` operators with quoted phrases.

### Fixed

- No white flash at launch.

## [0.2.9] - 2026-07-14

### Added

- A flow for signing an account back in.
- Address chips in the thread view.
- A redesigned calendar event form.
- Notifications while the window is unfocused.

### Fixed

- Recovery from misdecoded MIME, and repair of the full-text index.
- Thread and message loading is faster thanks to batching.

### Changed

- One NSIS installer for Windows, and tidier release assets.

## [0.2.8] - 2026-07-14

### Added

- A cinematic first-run intro.

### Fixed

- The keyring prompt now appears after the intro, not during it.
- Sync handles failures better, and notifications have been improved.

## [0.2.7] - 2026-07-13

### Fixed

- No more blip on the first click; audio is unlocked silently.
- Robot senders (noreply, alerts) never trigger the chime.

## [0.2.6] - 2026-07-13

### Fixed

- No chime for mail that arrived while Comail was closed.
- Hovering no longer selects rows in the thread list.

## [0.2.5] - 2026-07-13

### Added

- Ask AI, with streamed reasoning and source previews.
- Search exclusions (`exclude:` and `-term`).
- An unread badge on the dock.
- Attachment previews.

## [0.2.4] - 2026-07-13

### Added

- Header backfill that resumes from checkpoints.
- A dedicated connection for history sync, so new mail arrives instantly over
  IDLE.

### Fixed

- Office 365 throttling.

## [0.2.3] - 2026-07-13

### Changed

- Smarter search ranking, and a rate limit on the chime.

### Fixed

- Shortcut routing.

## [0.2.2] - 2026-07-13

### Added

- Message details with "via", sender search, and sounds.

### Changed

- Improvements to sync and IMAP.

## [0.2.1] - 2026-07-12

### Fixed

- OAuth issues. Logs now persist, and the setup guide has been overhauled.

[Unreleased]: https://github.com/NextOSP/comail/compare/v0.2.36...HEAD
[0.2.36]: https://github.com/NextOSP/comail/releases/tag/v0.2.36
[0.2.35]: https://github.com/NextOSP/comail/releases/tag/v0.2.35
[0.2.34]: https://github.com/NextOSP/comail/releases/tag/v0.2.34
[0.2.33]: https://github.com/NextOSP/comail/releases/tag/v0.2.33
[0.2.32]: https://github.com/NextOSP/comail/releases/tag/v0.2.32
[0.2.31]: https://github.com/NextOSP/comail/releases/tag/v0.2.31
[0.2.30]: https://github.com/NextOSP/comail/releases/tag/v0.2.30
[0.2.29]: https://github.com/NextOSP/comail/releases/tag/v0.2.29
[0.2.28]: https://github.com/NextOSP/comail/releases/tag/v0.2.28
[0.2.27]: https://github.com/NextOSP/comail/releases/tag/v0.2.27
[0.2.26]: https://github.com/NextOSP/comail/releases/tag/v0.2.26
[0.2.25]: https://github.com/NextOSP/comail/releases/tag/v0.2.25
[0.2.24]: https://github.com/NextOSP/comail/releases/tag/v0.2.24
[0.2.23]: https://github.com/NextOSP/comail/releases/tag/v0.2.23
[0.2.22]: https://github.com/NextOSP/comail/releases/tag/v0.2.22
[0.2.21]: https://github.com/NextOSP/comail/releases/tag/v0.2.21
[0.2.20]: https://github.com/NextOSP/comail/releases/tag/v0.2.20
[0.2.19]: https://github.com/NextOSP/comail/releases/tag/v0.2.19
[0.2.18]: https://github.com/NextOSP/comail/releases/tag/v0.2.18
[0.2.17]: https://github.com/NextOSP/comail/releases/tag/v0.2.17
[0.2.16]: https://github.com/NextOSP/comail/releases/tag/v0.2.16
[0.2.15]: https://github.com/NextOSP/comail/releases/tag/v0.2.15
[0.2.14]: https://github.com/NextOSP/comail/releases/tag/v0.2.14
[0.2.13]: https://github.com/NextOSP/comail/releases/tag/v0.2.13
[0.2.12]: https://github.com/NextOSP/comail/releases/tag/v0.2.12
[0.2.11]: https://github.com/NextOSP/comail/releases/tag/v0.2.11
[0.2.10]: https://github.com/NextOSP/comail/releases/tag/v0.2.10
[0.2.9]: https://github.com/NextOSP/comail/releases/tag/v0.2.9
[0.2.8]: https://github.com/NextOSP/comail/releases/tag/v0.2.8
[0.2.7]: https://github.com/NextOSP/comail/releases/tag/v0.2.7
[0.2.6]: https://github.com/NextOSP/comail/releases/tag/v0.2.6
[0.2.5]: https://github.com/NextOSP/comail/releases/tag/v0.2.5
[0.2.4]: https://github.com/NextOSP/comail/releases/tag/v0.2.4
[0.2.3]: https://github.com/NextOSP/comail/releases/tag/v0.2.3
[0.2.2]: https://github.com/NextOSP/comail/releases/tag/v0.2.2
[0.2.1]: https://github.com/NextOSP/comail/commit/00e9056
