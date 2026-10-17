//! One-time verification codes ("Your code is 482913") found in received mail.
//!
//! A code is a short digit run (or uppercase letter+digit token) that sits
//! close to a verification keyword in the subject or the start of the body.
//! Context-free numbers - prices, phone numbers, years, times, order numbers -
//! are rejected, so the result is safe to surface in a notification, copy to
//! the clipboard, or hand to Siri.

use once_cell::sync::Lazy;
use regex::Regex;

/// Only the top of a message is scanned: codes live in the first lines.
const SCAN_CHARS: usize = 2_000;
/// Max byte distance between a candidate and its nearest keyword.
const MAX_DISTANCE: usize = 120;

static KEYWORDS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(?:code|codes|otp|passcode|pin|verification|verify|verifying|one[- ]time|2fa|two[- ]factor|two[- ]step|authentication|authenticate|security|log ?in|sign ?in|confirm|confirmation|token)\b|c[oó]digo|v[ée]rification|bestätigung|kod\b|mã|xác (?:minh|thực|nhận)|验证码|驗證碼|校验码|确认码|动态码|認証|確認コード|인증",
    )
    .expect("otp keyword regex")
});

/// Candidates: 4-8 digits, "123 456" / "ABC-123" split codes, an optional
/// short prefix like Google's "G-", or 6-8 char uppercase/digit tokens.
static CANDIDATES: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b(?:[A-Z0-9]{3}-[A-Z0-9]{3}|(?:[A-Z]{1,3}-)?(?:\d{3}[ -]\d{3}|\d{4,8}|[A-Z0-9]{6,8}))\b",
    )
    .expect("otp regex")
});

/// The verification code in a message, if there is one.
pub fn extract(subject: &str, body: &str) -> Option<String> {
    find(subject).or_else(|| {
        let head: String = body.chars().take(SCAN_CHARS).collect();
        find(&head)
    })
}

fn find(text: &str) -> Option<String> {
    let keywords: Vec<(usize, usize)> = KEYWORDS
        .find_iter(text)
        .map(|m| (m.start(), m.end()))
        .collect();
    if keywords.is_empty() {
        return None;
    }
    let mut best: Option<(usize, String)> = None;
    for m in CANDIDATES.find_iter(text) {
        let Some(code) = normalize(m.as_str()) else {
            continue;
        };
        if !plausible_context(text, m.start(), m.end(), &code) {
            continue;
        }
        let distance = keywords
            .iter()
            .map(|&(ks, ke)| {
                if ke <= m.start() {
                    m.start() - ke
                } else if m.end() <= ks {
                    ks - m.end()
                } else {
                    0
                }
            })
            .min()
            .unwrap_or(usize::MAX);
        if distance <= MAX_DISTANCE && best.as_ref().is_none_or(|(d, _)| distance < *d) {
            best = Some((distance, code));
        }
    }
    best.map(|(_, code)| code)
}

/// Strip a letter prefix ("G-482913") and inner separator ("482 913"), and
/// reject tokens that aren't code-shaped (plain words, years).
fn normalize(raw: &str) -> Option<String> {
    // "G-482913": drop the letter prefix; "ABC-123" / "482-913": join halves.
    let token = match raw.split_once('-') {
        Some((prefix, rest))
            if prefix.chars().all(|c| c.is_ascii_uppercase())
                && rest.len() >= 4
                && rest.chars().all(|c| c.is_ascii_digit()) =>
        {
            rest
        }
        _ => raw,
    };
    let code: String = token
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let digits = code.chars().filter(char::is_ascii_digit).count();
    let letters = code.len() - digits;
    if digits == 0 {
        return None; // "SECURITY", "WELCOME"
    }
    if letters > 0 && digits < 2 {
        return None; // "ABCDE1" is more likely a reference than a code
    }
    if letters == 0 && code.len() == 4 {
        let year: u32 = code.parse().ok()?;
        if (1900..=2099).contains(&year) {
            return None;
        }
    }
    Some(code)
}

/// Reject numbers whose surroundings mark them as something else: money,
/// phone numbers, times/dates, decimals, percentages, order/reference ids.
fn plausible_context(text: &str, start: usize, end: usize, code: &str) -> bool {
    // Touching the number: "14:30", "12/10", "1.234". After a space, a colon
    // is fine ("code: 1234") but currency, phone and id markers are not.
    let adjacent = text[..start].chars().next_back();
    let before = text[..start].trim_end_matches(' ');
    let prev = before.chars().next_back();
    let next = text[end..].chars().next();
    if matches!(adjacent, Some('/' | ':' | '.' | ',' | '('))
        || matches!(prev, Some('$' | '€' | '£' | '¥' | '+' | '#'))
        || matches!(next, Some('%' | '/' | ':' | '€' | '$'))
    {
        return false;
    }
    // "1.234,56" style: a separator immediately followed by more digits.
    let mut after = text[end..].chars();
    if matches!(after.next(), Some('.' | ',')) && after.next().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    let lead: String = before
        .chars()
        .rev()
        .take(24)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .to_lowercase();
    const REFERENCES: [&str; 9] = [
        "order", "invoice", "ticket", "case", "ref", "account", "tracking", "phone", "call",
    ];
    if REFERENCES.iter().any(|w| lead.contains(w)) && !lead.contains("code") {
        return false;
    }
    !code.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(subject: &str, body: &str) -> Option<String> {
        extract(subject, body)
    }

    #[test]
    fn finds_common_formats() {
        let cases = [
            (
                "Your verification code",
                "Your code is 482913. It expires in 10 minutes.",
                "482913",
            ),
            ("482913 is your Instagram code", "", "482913"),
            (
                "Google verification",
                "G-735201 is your Google verification code.",
                "735201",
            ),
            (
                "Sign in to Slack",
                "Your confirmation code is below\n\n  ABC-123  \n",
                "ABC123",
            ),
            ("Login attempt", "Use 917 204 to sign in.", "917204"),
            ("Security alert", "Your one-time passcode: 5521", "5521"),
            ("Microsoft account", "Security code: 0045812", "0045812"),
            ("Mã xác minh", "Mã xác minh của bạn là 662810", "662810"),
            ("验证码", "您的验证码是 318277，5分钟内有效。", "318277"),
            (
                "Code de vérification",
                "Votre code de vérification est 774120.",
                "774120",
            ),
            ("Tu código", "Tu código de acceso es 903311", "903311"),
            (
                "Verify your email",
                "Enter K7Q9X2 in the app to verify.",
                "K7Q9X2",
            ),
        ];
        for (s, b, want) in cases {
            assert_eq!(code(s, b).as_deref(), Some(want), "{s} / {b}");
        }
    }

    #[test]
    fn ignores_numbers_that_are_not_codes() {
        let cases = [
            (
                "Your order has shipped",
                "Order #48291344 will arrive Tuesday.",
            ),
            ("Invoice", "Amount due: $4,812.00 by 2026-11-01."),
            (
                "Meeting",
                "Let's meet at 14:30 on 12/10, call me at +1 415 555 0134.",
            ),
            (
                "Newsletter",
                "Copyright 2026. 120 Main Street, Springfield.",
            ),
            ("Promo", "Use code SUMMER for 25% off!"),
            ("Weekly digest", "You had 18234 views this week."),
            (
                "Your receipt",
                "Order number 553201. Thanks for shopping with us.",
            ),
        ];
        for (s, b) in cases {
            assert_eq!(code(s, b), None, "{s} / {b}");
        }
    }

    #[test]
    fn prefers_the_number_nearest_the_keyword() {
        let body = "Hi Ana, thanks for order 7781. Your login code is 552019. Expires 2026.";
        assert_eq!(code("Hello", body).as_deref(), Some("552019"));
    }

    #[test]
    fn subject_wins_over_body() {
        assert_eq!(
            code("Your code: 118822", "Reference 990011 security code").as_deref(),
            Some("118822")
        );
    }
}
