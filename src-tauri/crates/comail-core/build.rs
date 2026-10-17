//! Builds the Apple Intelligence (Foundation Models) bridge on macOS.
//!
//! `swift/AppleIntelligence.swift` is compiled into a static library and linked
//! into comail-core, and the `apple_intelligence` cfg is set so `ai::apple`
//! calls into it. FoundationModels and the Swift concurrency runtime end up
//! weak-linked, so the binary still launches on macOS < 26 and Intel Macs (the
//! bridge reports the model as unavailable there).
//!
//! Skipped (cfg left unset; the provider reports "unsupported") off macOS, when
//! the SDK predates FoundationModels (Xcode < 26), or with
//! `COMAIL_NO_APPLE_INTELLIGENCE=1`.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const SWIFT_SRC: &str = "swift/AppleIntelligence.swift";

fn main() {
    println!("cargo::rustc-check-cfg=cfg(apple_intelligence)");
    println!("cargo:rerun-if-changed={SWIFT_SRC}");
    println!("cargo:rerun-if-env-changed=COMAIL_NO_APPLE_INTELLIGENCE");
    println!("cargo:rerun-if-env-changed=COMAIL_REQUIRE_APPLE_INTELLIGENCE");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")
        || env::var_os("COMAIL_NO_APPLE_INTELLIGENCE").is_some()
    {
        return;
    }
    if let Err(why) = build_bridge() {
        // Release CI sets this so a runner with an old SDK can't silently
        // ship a build without the provider.
        if env::var_os("COMAIL_REQUIRE_APPLE_INTELLIGENCE").is_some() {
            panic!("Apple Intelligence bridge required but not built: {why}");
        }
        println!("cargo:warning=Apple Intelligence provider disabled: {why}");
    }
}

fn xcrun(args: &[&str]) -> Result<String, String> {
    let out = Command::new("xcrun")
        .args(args)
        .output()
        .map_err(|e| format!("xcrun unavailable ({e})"))?;
    if !out.status.success() {
        return Err(format!(
            "xcrun {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn build_bridge() -> Result<(), String> {
    let sdk = xcrun(&["--sdk", "macosx", "--show-sdk-path"])?;
    if !Path::new(&sdk)
        .join("System/Library/Frameworks/FoundationModels.framework")
        .exists()
    {
        return Err(format!("{sdk} has no FoundationModels (needs Xcode 26+)"));
    }
    let swiftc = xcrun(&["--sdk", "macosx", "--find", "swiftc"])?;

    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => return Err(format!("unsupported arch {other:?}")),
    };
    // Match the Rust link's deployment target (Tauri exports it from
    // `bundle.macOS.minimumSystemVersion`); fall back to rustc's defaults.
    let min_os = env::var("MACOSX_DEPLOYMENT_TARGET")
        .unwrap_or_else(|_| if arch == "arm64" { "11.0" } else { "10.15" }.into());

    let out_dir = PathBuf::from(env::var("OUT_DIR").map_err(|e| e.to_string())?);
    let lib = out_dir.join("libcomail_apple_intelligence.a");
    let status = Command::new(&swiftc)
        .args(["-parse-as-library", "-emit-library", "-static", "-O"])
        .args(["-module-name", "ComailAppleIntelligence"])
        .args(["-target", &format!("{arch}-apple-macosx{min_os}")])
        .args(["-sdk", &sdk])
        .arg("-module-cache-path")
        .arg(out_dir.join("swift-module-cache"))
        .arg("-o")
        .arg(&lib)
        .arg(SWIFT_SRC)
        .status()
        .map_err(|e| format!("couldn't run swiftc ({e})"))?;
    if !status.success() {
        return Err(format!("swiftc exited with {status}"));
    }

    // The Swift objects autolink their runtime libraries; the linker just needs
    // to find them: the OS copies in /usr/lib/swift plus the toolchain's
    // back-deployment compatibility shims.
    let toolchain_lib = Path::new(&swiftc)
        .parent()
        .and_then(Path::parent)
        .map(|p| p.join("lib/swift/macosx"))
        .ok_or("unexpected swiftc path")?;
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain_lib.display());
    println!("cargo:rustc-link-lib=static=comail_apple_intelligence");
    // libswift_Concurrency is referenced via @rpath; binaries linking this
    // crate need /usr/lib/swift on their rpath (see src-tauri/build.rs). This
    // covers comail-core's own test binaries.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo:rustc-cfg=apple_intelligence");
    Ok(())
}
