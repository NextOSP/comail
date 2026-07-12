//! SMTP sending via lettre, with password or XOAUTH2 auth.

use crate::error::{CoreError, Result};
use crate::models::AccountConfig;
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

pub enum SmtpAuth {
    Password(String),
    XOAuth2(String),
}

fn build_transport(
    cfg: &AccountConfig,
    auth: &SmtpAuth,
) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    use lettre::transport::smtp::client::{Tls, TlsParameters};

    let mut builder = if cfg.smtp_port == 465 {
        // Implicit TLS
        AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.smtp_host)
            .map_err(|e| CoreError::Smtp(e.to_string()))?
            .port(cfg.smtp_port)
    } else {
        // STARTTLS (587 and friends)
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.smtp_host)
            .map_err(|e| CoreError::Smtp(e.to_string()))?
            .port(cfg.smtp_port)
    };

    if crate::imap::tls_insecure() {
        let params = TlsParameters::builder(cfg.smtp_host.clone())
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| CoreError::Smtp(e.to_string()))?;
        builder = if cfg.smtp_port == 465 {
            builder.tls(Tls::Wrapper(params))
        } else {
            builder.tls(Tls::Required(params))
        };
    }

    let builder = match auth {
        SmtpAuth::Password(pw) => builder
            .credentials(Credentials::new(cfg.username.clone(), pw.clone()))
            .authentication(vec![Mechanism::Plain, Mechanism::Login]),
        SmtpAuth::XOAuth2(token) => builder
            .credentials(Credentials::new(cfg.username.clone(), token.clone()))
            .authentication(vec![Mechanism::Xoauth2]),
    };

    Ok(builder.build())
}

/// Send a fully built RFC 5322 message.
pub async fn send_raw(
    cfg: &AccountConfig,
    auth: &SmtpAuth,
    from: &str,
    recipients: &[String],
    raw: &[u8],
) -> Result<()> {
    use lettre::address::Envelope;
    let from_addr = from
        .parse()
        .map_err(|e| CoreError::Smtp(format!("bad from address: {e}")))?;
    let mut tos = Vec::with_capacity(recipients.len());
    for r in recipients {
        tos.push(
            r.parse()
                .map_err(|e| CoreError::Smtp(format!("bad recipient {r}: {e}")))?,
        );
    }
    let envelope =
        Envelope::new(Some(from_addr), tos).map_err(|e| CoreError::Smtp(e.to_string()))?;

    let transport = build_transport(cfg, auth)?;
    transport.send_raw(&envelope, raw).await.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("535") || msg.to_lowercase().contains("auth") {
            CoreError::Auth(format!("smtp auth: {msg}"))
        } else {
            CoreError::Smtp(msg)
        }
    })?;
    Ok(())
}

/// Cheap connectivity/auth probe used by test_connection.
pub async fn test_connection(cfg: &AccountConfig, auth: &SmtpAuth) -> Result<()> {
    let transport = build_transport(cfg, auth)?;
    let ok = transport
        .test_connection()
        .await
        .map_err(|e| CoreError::Smtp(e.to_string()))?;
    if ok {
        Ok(())
    } else {
        Err(CoreError::Smtp("connection test failed".into()))
    }
}
