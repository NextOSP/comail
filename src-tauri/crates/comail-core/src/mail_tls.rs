//! Certificate validation shared by IMAP and SMTP.

use crate::error::{CoreError, Result};
use rustls::pki_types::{CertificateDer, pem::PemObject};
use std::sync::Arc;
use tokio_rustls::TlsConnector;

pub trait MailStream:
    tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + std::fmt::Debug
{
}
impl<T> MailStream for T where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + std::fmt::Debug
{
}
pub type SecureStream = Box<dyn MailStream>;

pub(crate) enum Connector {
    Rustls(TlsConnector),
    Native(tokio_native_tls::TlsConnector),
}

impl Connector {
    pub(crate) async fn connect(
        self,
        host: &str,
        tcp: tokio::net::TcpStream,
    ) -> Result<SecureStream> {
        match self {
            Self::Rustls(connector) => {
                let name = rustls::pki_types::ServerName::try_from(host.to_owned())
                    .map_err(|e| CoreError::Tls(e.to_string()))?;
                Ok(Box::new(
                    connector
                        .connect(name, tcp)
                        .await
                        .map_err(|e| CoreError::Tls(e.to_string()))?,
                ))
            }
            Self::Native(connector) => Ok(Box::new(
                connector
                    .connect(host, tcp)
                    .await
                    .map_err(|e| CoreError::Tls(e.to_string()))?,
            )),
        }
    }
}

/// Dev/self-hosted escape hatch: COMAIL_TLS_INSECURE=1 disables certificate
/// verification (e.g. self-signed Dovecot). Off by default; never set it for
/// real accounts.
pub fn tls_insecure() -> bool {
    std::env::var("COMAIL_TLS_INSECURE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub fn tls_connector() -> TlsConnector {
    static CONFIG: once_cell::sync::Lazy<Arc<rustls::ClientConfig>> =
        once_cell::sync::Lazy::new(|| Arc::new(client_config()));
    TlsConnector::from(CONFIG.clone())
}

pub(crate) fn connector(trusted_certificate: Option<&str>) -> Result<Connector> {
    match trusted_certificate {
        None => Ok(Connector::Rustls(tls_connector())),
        Some(pem) => {
            // Platform validation accepts Bridge's explicitly trusted CA as
            // a server certificate. Rustls rejects that certificate shape.
            let mut builder = native_tls::TlsConnector::builder();
            builder
                .disable_built_in_roots(true)
                .min_protocol_version(Some(native_tls::Protocol::Tlsv12));
            for certificate in certificates(pem)? {
                builder.add_root_certificate(
                    native_tls::Certificate::from_der(certificate.as_ref())
                        .map_err(|_| CoreError::Tls("invalid trust certificate".into()))?,
                );
            }
            if tls_insecure() {
                builder
                    .danger_accept_invalid_certs(true)
                    .danger_accept_invalid_hostnames(true);
            }
            let connector = builder.build().map_err(|e| CoreError::Tls(e.to_string()))?;
            Ok(Connector::Native(tokio_native_tls::TlsConnector::from(
                connector,
            )))
        }
    }
}

/// Public certificates only. Bound pasted input before decoding it.
pub(crate) fn certificates(pem: &str) -> Result<Vec<CertificateDer<'static>>> {
    if pem.len() > 64 * 1024 || pem.contains("PRIVATE KEY-----") {
        return Err(CoreError::Tls(
            "expected a certificate bundle of at most 64 KiB".into(),
        ));
    }
    let certs = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| CoreError::Tls("invalid PEM certificate".into()))?;
    if certs.is_empty() {
        return Err(CoreError::Tls("no PEM certificate found".into()));
    }
    let mut roots = rustls::RootCertStore::empty();
    for cert in &certs {
        roots
            .add(cert.clone())
            .map_err(|_| CoreError::Tls("invalid trust certificate".into()))?;
    }
    Ok(certs)
}

fn client_config() -> rustls::ClientConfig {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    if tls_insecure() {
        tracing::warn!("COMAIL_TLS_INSECURE=1: TLS certificate verification is DISABLED");
        let provider = rustls::crypto::CryptoProvider::get_default()
            .cloned()
            .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(NoVerify(provider)));
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_trust_material_must_be_a_bounded_public_certificate() {
        let certificate = include_str!("../tests/fixtures/tls/ca.pem");
        assert_eq!(certificates(certificate).unwrap().len(), 1);
        for input in [
            String::new(),
            "not a certificate".into(),
            "-----BEGIN CERTIFICATE-----\ninvalid!\n-----END CERTIFICATE-----".into(),
            format!("{certificate}\n-----BEGIN PRIVATE KEY-----"),
            "x".repeat(65_537),
        ] {
            assert!(certificates(&input).is_err());
        }
    }
}
