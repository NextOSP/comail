//! Email address normalization for rule matching across scripts.
//!
//! Addresses are compared in lowercase Unicode form: local parts may be
//! non-ASCII (RFC 6532) and domains may arrive either as Unicode
//! (`müller.de`) or as IDNA A-labels (`xn--mller-kva.de`) depending on the
//! sender's software. Decoding A-labels on both sides makes a rule typed
//! either way match mail sent either way. Rust's `to_lowercase` is
//! Unicode-aware, unlike SQLite's ASCII-only `LOWER()` / `NOCASE`.

/// Lowercase a domain and decode any IDNA A-labels (`xn--…`) to Unicode.
/// Text without A-labels is only lowercased, so partial input like a bare
/// label or a local-part fragment passes through untouched.
pub fn normalize_domain(domain: &str) -> String {
    let lower = domain.trim().to_lowercase();
    if lower.contains("xn--") {
        let (unicode, _errors) = idna::domain_to_unicode(&lower);
        unicode.to_lowercase()
    } else {
        lower
    }
}

/// Normalize a full or partial address (`Bob@XN--MLLER-KVA.DE` ->
/// `bob@müller.de`). Without an `@` the whole input is treated as a domain
/// fragment.
pub fn normalize(addr: &str) -> String {
    let addr = addr.trim();
    match addr.rsplit_once('@') {
        Some((local, domain)) => format!("{}@{}", local.to_lowercase(), normalize_domain(domain)),
        None => normalize_domain(addr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idn_domains_match_in_either_form() {
        assert_eq!(normalize("Bob@XN--MLLER-KVA.DE"), "bob@müller.de");
        assert_eq!(normalize("bob@Müller.de"), "bob@müller.de");
        assert_eq!(normalize("@xn--mller-kva.de"), "@müller.de");
        assert_eq!(normalize("xn--mller-kva.de"), "müller.de");
        // Japanese IDN and a Unicode local part (RFC 6532).
        assert_eq!(normalize("info@xn--wgv71a119e.jp"), "info@日本語.jp");
        assert_eq!(normalize("ÆØÅ@Example.NO"), "æøå@example.no");
    }

    #[test]
    fn fragments_pass_through() {
        assert_eq!(normalize("  GitHub "), "github");
        assert_eq!(normalize("noreply@"), "noreply@");
        assert_eq!(normalize("first.last+tag"), "first.last+tag");
    }
}
