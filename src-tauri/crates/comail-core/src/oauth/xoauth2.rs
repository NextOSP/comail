use base64::Engine;

/// SASL XOAUTH2 initial client response, base64-encoded.
/// Format: "user=" {email} ^A "auth=Bearer " {token} ^A ^A
pub fn initial_response(user: &str, access_token: &str) -> String {
    let raw = format!("user={user}\x01auth=Bearer {access_token}\x01\x01");
    base64::engine::general_purpose::STANDARD.encode(raw)
}

/// The raw (un-encoded) form; async-imap's authenticate() encodes it itself.
pub fn raw_response(user: &str, access_token: &str) -> String {
    format!("user={user}\x01auth=Bearer {access_token}\x01\x01")
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes() {
        let enc = super::initial_response("a@b.c", "tok");
        let dec = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, enc).unwrap();
        assert_eq!(dec, b"user=a@b.c\x01auth=Bearer tok\x01\x01");
    }
}
