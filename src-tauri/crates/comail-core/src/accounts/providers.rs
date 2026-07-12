//! Well-known server settings for OAuth providers. (Password/IMAP presets for
//! Fastmail/iCloud etc. live in the frontend onboarding form.)

pub struct ProviderServers {
    pub imap_host: &'static str,
    pub imap_port: u16,
    pub smtp_host: &'static str,
    pub smtp_port: u16,
}

pub const GMAIL: ProviderServers = ProviderServers {
    imap_host: "imap.gmail.com",
    imap_port: 993,
    smtp_host: "smtp.gmail.com",
    smtp_port: 465,
};

pub const MICROSOFT: ProviderServers = ProviderServers {
    imap_host: "outlook.office365.com",
    imap_port: 993,
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
};
