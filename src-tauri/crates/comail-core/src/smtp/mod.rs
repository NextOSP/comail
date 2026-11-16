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
    use lettre::transport::smtp::client::{Certificate, CertificateStore, Tls, TlsParameters};

    let mut params = TlsParameters::builder(cfg.smtp_host.clone());
    if let Some(pem) = &cfg.trusted_certificate {
        params = params.certificate_store(CertificateStore::None);
        for cert in crate::mail_tls::certificates(pem)? {
            params = params.add_root_certificate(
                Certificate::from_der(cert.as_ref().to_vec())
                    .map_err(|_| CoreError::Tls("invalid trust certificate".into()))?,
            );
        }
    }
    if crate::imap::tls_insecure() {
        params = params
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true);
    }
    // Enabling lettre's native backend must not change existing accounts.
    let params = if cfg.trusted_certificate.is_some() {
        params.build_native()
    } else {
        params.build_rustls()
    }
    .map_err(|e| CoreError::Smtp(e.to_string()))?;
    let tls = if cfg.smtp_port == 465 {
        Tls::Wrapper(params)
    } else {
        Tls::Required(params)
    };
    let builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.smtp_host)
        .port(cfg.smtp_port)
        .tls(tls);

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
    tracing::debug!(
        host = %cfg.smtp_host,
        port = cfg.smtp_port,
        auth = match auth {
            SmtpAuth::Password(_) => "password",
            SmtpAuth::XOAuth2(_) => "xoauth2",
        },
        bytes = raw.len(),
        recipients = recipients.len(),
        "smtp send_raw: connecting to relay",
    );
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
