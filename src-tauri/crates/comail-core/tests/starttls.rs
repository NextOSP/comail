//! Local protocol fixtures verify that credentials never precede TLS.

use comail_core::{
    imap,
    models::{AccountConfig, AuthKind, ImapSecurity, Provider},
    smtp,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;

const DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
enum CertificateKind {
    Server,
    Bridge,
    ExpiredBridge,
}

struct Certificates {
    ca: String,
    server: Vec<u8>,
    server_key: Vec<u8>,
    bridge: String,
    bridge_key: Vec<u8>,
    expired: String,
}

fn certificates() -> &'static Certificates {
    static CERTIFICATES: once_cell::sync::Lazy<Certificates> = once_cell::sync::Lazy::new(|| {
        use rcgen::{
            BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
        };
        fn params(ca: bool, expired: bool) -> CertificateParams {
            let mut p = CertificateParams::new(vec!["localhost".into()]).unwrap();
            let now = time::OffsetDateTime::now_utc();
            // Generate short-lived certificates at runtime: platform lifetime
            // limits must not make fixed, long-lived fixtures fail or expire.
            p.not_before = now - time::Duration::days(if expired { 3 } else { 1 });
            p.not_after = now + time::Duration::days(if expired { -2 } else { 1 });
            p.is_ca = if ca {
                IsCa::Ca(BasicConstraints::Unconstrained)
            } else {
                IsCa::NoCa
            };
            p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            p
        }
        let ca_key = KeyPair::generate().unwrap();
        let ca_params = params(true, false);
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::from_params(&ca_params, ca_key);
        let server_key = KeyPair::generate().unwrap();
        let server = params(false, false)
            .signed_by(&server_key, &issuer)
            .unwrap();
        let bridge_key =
            KeyPair::generate_rsa_for(&rcgen::PKCS_RSA_SHA256, rcgen::RsaKeySize::_2048).unwrap();
        let bridge_certificate = |expired| {
            let mut p = params(true, expired);
            p.distinguished_name
                .push(rcgen::DnType::CommonName, "127.0.0.1");
            // macOS can reject a newly issued 20-year certificate under its
            // lifetime policy, even with an explicit anchor. Keep the macOS
            // fixture policy-valid so it exercises the rest of the handshake.
            if !expired && !cfg!(target_os = "macos") {
                p.not_after = p.not_before + time::Duration::days(20 * 365);
            }
            p.subject_alt_names = vec![rcgen::SanType::IpAddress(
                std::net::Ipv4Addr::LOCALHOST.into(),
            )];
            p.key_usages = vec![
                rcgen::KeyUsagePurpose::DigitalSignature,
                rcgen::KeyUsagePurpose::KeyEncipherment,
                rcgen::KeyUsagePurpose::KeyCertSign,
            ];
            p.extended_key_usages
                .push(ExtendedKeyUsagePurpose::ClientAuth);
            p.self_signed(&bridge_key).unwrap()
        };
        let bridge = bridge_certificate(false);
        let expired = bridge_certificate(true);
        Certificates {
            ca: ca.pem(),
            server: server.der().to_vec(),
            server_key: server_key.serialize_der(),
            bridge: bridge.pem(),
            bridge_key: bridge_key.serialize_der(),
            expired: expired.pem(),
        }
    });
    &CERTIFICATES
}

fn ca() -> &'static str {
    &certificates().ca
}
fn bridge_certificate() -> &'static str {
    &certificates().bridge
}
fn expired_certificate() -> &'static str {
    &certificates().expired
}

fn acceptor(kind: CertificateKind) -> TlsAcceptor {
    use rustls::pki_types::pem::PemObject;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let fixture = certificates();
    let (certificate, key) = match kind {
        CertificateKind::Server => (
            CertificateDer::from(fixture.server.clone()),
            &fixture.server_key,
        ),
        CertificateKind::Bridge => (
            CertificateDer::from_pem_slice(fixture.bridge.as_bytes()).unwrap(),
            &fixture.bridge_key,
        ),
        CertificateKind::ExpiredBridge => (
            CertificateDer::from_pem_slice(fixture.expired.as_bytes()).unwrap(),
            &fixture.bridge_key,
        ),
    };
    let key = PrivateKeyDer::try_from(key.to_vec()).unwrap();
    TlsAcceptor::from(Arc::new(
        rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .unwrap(),
    ))
}

async fn read_line<T: AsyncRead + Unpin>(stream: &mut BufReader<T>) -> String {
    let mut line = String::new();
    tokio::time::timeout(DEADLINE, stream.read_line(&mut line))
        .await
        .expect("protocol step timed out")
        .expect("protocol read failed");
    line
}

async fn write<T: AsyncWrite + Unpin>(stream: &mut T, text: &str) {
    stream.write_all(text.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
}

#[derive(Clone, Copy)]
enum Server {
    Starttls,
    ImplicitTls,
    RefuseUpgrade,
}

async fn imap_server(mode: Server) -> (u16, JoinHandle<bool>) {
    imap_server_with_certificate(mode, CertificateKind::Server).await
}

async fn imap_server_with_certificate(
    mode: Server,
    certificate: CertificateKind,
) -> (u16, JoinHandle<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (tcp, _) = tokio::time::timeout(DEADLINE, listener.accept())
            .await
            .unwrap()
            .unwrap();
        let tcp = match mode {
            Server::ImplicitTls => tcp,
            _ => {
                let mut clear = BufReader::new(tcp);
                write(clear.get_mut(), "* OK local IMAP ready\r\n").await;
                let command = read_line(&mut clear).await;
                let (tag, text) = command.trim_end().split_once(' ').expect("tagged command");
                assert_eq!(
                    text, "STARTTLS",
                    "credentials must not cross the plaintext connection"
                );
                if matches!(mode, Server::RefuseUpgrade) {
                    write(clear.get_mut(), &format!("{tag} NO upgrade refused\r\n")).await;
                    assert!(
                        read_line(&mut clear).await.is_empty(),
                        "a refused upgrade must close without LOGIN"
                    );
                    return false;
                }
                write(clear.get_mut(), &format!("{tag} OK begin TLS\r\n")).await;
                clear.into_inner()
            }
        };
        let tls = match tokio::time::timeout(DEADLINE, acceptor(certificate).accept(tcp))
            .await
            .unwrap()
        {
            Ok(tls) => tls,
            Err(_) => return false, // The client rejected the certificate before authentication.
        };
        let mut encrypted = BufReader::new(tls);
        if matches!(mode, Server::ImplicitTls) {
            write(encrypted.get_mut(), "* OK local IMAP ready\r\n").await;
        }
        // No greeting is sent after STARTTLS. Waiting for one would deadlock.
        let command = read_line(&mut encrypted).await;
        if command.is_empty() {
            return false;
        }
        let (tag, text) = command.trim_end().split_once(' ').expect("tagged login");
        assert!(text.starts_with("LOGIN "));
        write(encrypted.get_mut(), &format!("{tag} OK authenticated\r\n")).await;
        true
    });
    (port, task)
}

fn credentials() -> imap::ImapCredentials {
    imap::ImapCredentials::Password {
        user: "test-user".into(),
        password: "test-password".into(),
    }
}

#[tokio::test]
async fn starttls_encrypts_login_and_does_not_wait_for_a_second_greeting() {
    let (port, server) = imap_server(Server::Starttls).await;
    let session = imap::connect_with_security(
        "localhost",
        port,
        credentials(),
        ImapSecurity::Starttls,
        Some(ca()),
    )
    .await;
    assert!(
        session.is_ok(),
        "trusted STARTTLS must connect: {:?}",
        session.as_ref().err()
    );
    assert!(server.await.unwrap(), "LOGIN must happen inside TLS");
}

#[tokio::test]
async fn refusing_starttls_never_falls_back_to_plaintext_login() {
    let (port, server) = imap_server(Server::RefuseUpgrade).await;
    let result = imap::connect_with_security(
        "localhost",
        port,
        credentials(),
        ImapSecurity::Starttls,
        Some(ca()),
    )
    .await;
    assert!(result.is_err());
    assert!(!server.await.unwrap());
}

#[tokio::test]
async fn account_certificate_does_not_trust_another_account_or_the_wrong_hostname() {
    for (host, certificate) in [("localhost", None), ("127.0.0.1", Some(ca()))] {
        let (port, server) = imap_server(Server::Starttls).await;
        assert!(
            imap::connect_with_security(
                host,
                port,
                credentials(),
                ImapSecurity::Starttls,
                certificate
            )
            .await
            .is_err()
        );
        assert!(
            !server.await.unwrap(),
            "untrusted TLS must never reach LOGIN"
        );
    }
}

#[tokio::test]
async fn implicit_tls_still_reads_its_greeting_before_login() {
    let (port, server) = imap_server(Server::ImplicitTls).await;
    let result = imap::connect_with_security(
        "localhost",
        port,
        credentials(),
        ImapSecurity::Tls,
        Some(ca()),
    )
    .await;
    assert!(result.is_ok(), "implicit TLS: {:?}", result.as_ref().err());
    assert!(server.await.unwrap());
}

fn smtp_config(port: u16, certificate: Option<&str>) -> AccountConfig {
    AccountConfig {
        id: 0,
        email: "test@example.test".into(),
        display_name: None,
        provider: Provider::Imap,
        auth_kind: AuthKind::Password,
        username: "test-user".into(),
        imap_host: "localhost".into(),
        imap_port: 1143,
        smtp_host: "localhost".into(),
        smtp_port: port,
        imap_security: ImapSecurity::Starttls,
        trusted_certificate: certificate.map(str::to_owned),
    }
}

async fn smtp_server(certificate: CertificateKind) -> (u16, JoinHandle<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (tcp, _) = tokio::time::timeout(DEADLINE, listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut clear = BufReader::new(tcp);
        write(clear.get_mut(), "220 localhost ESMTP\r\n").await;
        assert!(read_line(&mut clear).await.starts_with("EHLO "));
        write(clear.get_mut(), "250-localhost\r\n250 STARTTLS\r\n").await;
        assert_eq!(
            read_line(&mut clear).await,
            "STARTTLS\r\n",
            "SMTP must encrypt before AUTH"
        );
        write(clear.get_mut(), "220 begin TLS\r\n").await;
        let tls =
            match tokio::time::timeout(DEADLINE, acceptor(certificate).accept(clear.into_inner()))
                .await
                .unwrap()
            {
                Ok(tls) => tls,
                Err(_) => return false,
            };
        let mut encrypted = BufReader::new(tls);
        let mut authenticated = false;
        loop {
            let line = read_line(&mut encrypted).await;
            if line.is_empty() {
                break;
            }
            if line.starts_with("EHLO ") {
                write(encrypted.get_mut(), "250-localhost\r\n250 AUTH PLAIN\r\n").await;
            } else if line.starts_with("AUTH PLAIN ") {
                authenticated = true;
                write(encrypted.get_mut(), "235 authenticated\r\n").await;
            } else if line == "NOOP\r\n" {
                assert!(authenticated);
                write(encrypted.get_mut(), "250 OK\r\n").await;
            } else if line == "QUIT\r\n" {
                write(encrypted.get_mut(), "221 bye\r\n").await;
                break;
            } else {
                panic!("connection probe must not send mail");
            }
        }
        authenticated
    });
    (port, task)
}

#[tokio::test]
async fn smtp_uses_the_account_certificate_and_authenticates_only_after_starttls() {
    for certificate in [Some(ca()), None] {
        let (port, server) = smtp_server(CertificateKind::Server).await;
        let result = smtp::test_connection(
            &smtp_config(port, certificate),
            &smtp::SmtpAuth::Password("test-password".into()),
        )
        .await;
        assert_eq!(
            result.is_ok(),
            certificate.is_some(),
            "SMTP: {:?}",
            result.as_ref().err()
        );
        assert_eq!(server.await.unwrap(), certificate.is_some());
    }
}

#[tokio::test]
async fn bridge_ca_as_server_requires_explicit_account_trust_and_matching_hostname() {
    for (host, trust, accepted) in [
        ("127.0.0.1", Some(bridge_certificate()), true),
        ("127.0.0.1", None, false),
        ("127.0.0.1", Some(ca()), false),
        ("localhost", Some(bridge_certificate()), false),
    ] {
        let (port, server) =
            imap_server_with_certificate(Server::Starttls, CertificateKind::Bridge).await;
        let result =
            imap::connect_with_security(host, port, credentials(), ImapSecurity::Starttls, trust)
                .await;
        assert_eq!(
            result.is_ok(),
            accepted,
            "Bridge-shaped certificate trust and hostname: {:?}",
            result.as_ref().err()
        );
        assert_eq!(
            server.await.unwrap(),
            accepted,
            "only a verified peer receives LOGIN"
        );
        let (port, server) = smtp_server(CertificateKind::Bridge).await;
        let mut config = smtp_config(port, trust);
        config.smtp_host = host.into();
        let result =
            smtp::test_connection(&config, &smtp::SmtpAuth::Password("test-password".into())).await;
        assert_eq!(
            result.is_ok(),
            accepted,
            "SMTP Bridge certificate trust and hostname: {:?}",
            result.as_ref().err()
        );
        assert_eq!(
            server.await.unwrap(),
            accepted,
            "only a verified peer receives AUTH"
        );
    }
}

#[tokio::test]
async fn importing_an_expired_bridge_certificate_never_authorizes_credentials() {
    let (port, server) =
        imap_server_with_certificate(Server::Starttls, CertificateKind::ExpiredBridge).await;
    assert!(
        imap::connect_with_security(
            "127.0.0.1",
            port,
            credentials(),
            ImapSecurity::Starttls,
            Some(expired_certificate())
        )
        .await
        .is_err()
    );
    assert!(!server.await.unwrap());
    let (port, server) = smtp_server(CertificateKind::ExpiredBridge).await;
    let mut config = smtp_config(port, Some(expired_certificate()));
    config.smtp_host = "127.0.0.1".into();
    assert!(
        smtp::test_connection(&config, &smtp::SmtpAuth::Password("test-password".into()))
            .await
            .is_err()
    );
    assert!(!server.await.unwrap());
}

/// Read-only check against a running local Bridge. The password comes from stdin.
#[tokio::test]
#[ignore = "requires COMAIL_BRIDGE_USER, COMAIL_BRIDGE_CERT, and password on stdin"]
async fn local_bridge_lists_folders_and_authenticates_smtp_without_sending_mail() {
    use std::io::Read;
    assert!(
        !imap::tls_insecure(),
        "this probe must verify the Bridge certificate"
    );
    let user = std::env::var("COMAIL_BRIDGE_USER").expect("Bridge username");
    let certificate =
        std::fs::read_to_string(std::env::var("COMAIL_BRIDGE_CERT").expect("certificate path"))
            .unwrap();
    let mut password = String::new();
    std::io::stdin()
        .take(1024)
        .read_to_string(&mut password)
        .unwrap();
    let password = password.trim_end_matches(['\r', '\n']).to_string();
    assert!(!password.is_empty(), "pass the Bridge password on stdin");
    let creds = imap::ImapCredentials::Password {
        user: user.clone(),
        password: password.clone(),
    };
    let mut session = imap::connect_with_security(
        "127.0.0.1",
        1143,
        creds,
        ImapSecurity::Starttls,
        Some(&certificate),
    )
    .await
    .expect("verified Bridge IMAP authentication");
    assert!(!imap::list_folders(&mut session).await.unwrap().is_empty());
    imap::logout(session).await;
    let mut config = smtp_config(1025, Some(&certificate));
    config.smtp_host = "127.0.0.1".into();
    config.username = user;
    smtp::test_connection(&config, &smtp::SmtpAuth::Password(password))
        .await
        .expect("verified Bridge SMTP authentication");
}
