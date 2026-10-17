//! Tauri build plus, on macOS, the Siri / Shortcuts (App Intents) bridge.
//!
//! `swift/ComailIntents.swift` is compiled into a static library and linked
//! into the app (cfg `apple_intents`), and Apple's appintentsmetadataprocessor
//! turns it into `gen/apple-intents/Metadata.appintents`, which tauri.conf's
//! `bundle.macOS.files` copies into Comail.app/Contents/Resources - the
//! system only offers an app's intents to Siri when that bundle is present.
//! Skipped (with a warning) off macOS or when the SDK lacks AppIntents; set
//! `COMAIL_REQUIRE_APPLE_INTELLIGENCE` to make that a hard error instead.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const SWIFT_SRC: &str = "swift/ComailIntents.swift";
const MODULE: &str = "ComailIntents";
/// Protocols whose conformances the compiler records for the metadata
/// processor (what Xcode passes for App Intents targets).
const CONST_PROTOCOLS: &str = r#"["AppIntent","EntityQuery","AppEntity","TransientEntity","AppEnum","AppShortcutProviding","AppShortcutsProvider","AnyResolverProviding","AppIntentsPackage","DynamicOptionsProvider"]"#;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(apple_intents)");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Swift concurrency (used by comail-core's Apple Intelligence bridge
        // and the intents) is referenced via @rpath; it lives in /usr/lib/swift.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        println!("cargo:rerun-if-changed={SWIFT_SRC}");
        println!("cargo:rerun-if-env-changed=COMAIL_REQUIRE_APPLE_INTELLIGENCE");
        println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
        if let Err(why) = build_intents() {
            if env::var_os("COMAIL_REQUIRE_APPLE_INTELLIGENCE").is_some() {
                panic!("App Intents bridge required but not built: {why}");
            }
            println!("cargo:warning=Siri / Shortcuts intents disabled: {why}");
        }
    }
    tauri_build::build()
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

fn run(cmd: &mut Command, what: &str) -> Result<(), String> {
    let out = cmd
        .output()
        .map_err(|e| format!("couldn't run {what} ({e})"))?;
    if !out.status.success() {
        return Err(format!(
            "{what} failed: {}{}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn build_intents() -> Result<(), String> {
    let sdk = xcrun(&["--sdk", "macosx", "--show-sdk-path"])?;
    if !Path::new(&sdk)
        .join("System/Library/Frameworks/AppIntents.framework")
        .exists()
    {
        return Err(format!("{sdk} has no AppIntents"));
    }
    let swiftc = xcrun(&["--sdk", "macosx", "--find", "swiftc"])?;
    let processor = xcrun(&["--sdk", "macosx", "--find", "appintentsmetadataprocessor"])?;
    let xcode_build = Command::new("xcodebuild")
        .arg("-version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find_map(|l| l.strip_prefix("Build version ").map(str::to_string))
        })
        .ok_or("couldn't read the Xcode build version")?;

    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => return Err(format!("unsupported arch {other:?}")),
    };
    let min_os = env::var("MACOSX_DEPLOYMENT_TARGET")
        .unwrap_or_else(|_| if arch == "arm64" { "11.0" } else { "10.15" }.into());
    let triple = format!("{arch}-apple-macosx{min_os}");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let out_dir = PathBuf::from(env::var("OUT_DIR").map_err(|e| e.to_string())?);
    let src = manifest.join(SWIFT_SRC);
    let protocols = out_dir.join("intents-protocols.json");
    let const_values = out_dir.join("ComailIntents.swiftconstvalues");
    std::fs::write(&protocols, CONST_PROTOCOLS).map_err(|e| e.to_string())?;

    let lib = out_dir.join("libcomail_intents.a");
    run(
        Command::new(&swiftc)
            .args(["-swift-version", "5", "-parse-as-library", "-wmo"])
            .args(["-emit-library", "-static", "-O"])
            .args(["-module-name", MODULE, "-target", &triple, "-sdk", &sdk])
            .arg("-module-cache-path")
            .arg(out_dir.join("swift-module-cache"))
            .arg("-emit-const-values-path")
            .arg(&const_values)
            .args(["-Xfrontend", "-const-gather-protocols-file", "-Xfrontend"])
            .arg(&protocols)
            .arg("-o")
            .arg(&lib)
            .arg(&src),
        "swiftc (intents)",
    )?;

    // Metadata.appintents is architecture-independent; every target build
    // rewrites the same copy for the bundler to pick up.
    let sources_list = out_dir.join("intents-sources.txt");
    let const_list = out_dir.join("intents-constvalues.txt");
    std::fs::write(&sources_list, format!("{}\n", src.display())).map_err(|e| e.to_string())?;
    std::fs::write(&const_list, format!("{}\n", const_values.display()))
        .map_err(|e| e.to_string())?;
    let toolchain = Path::new(&swiftc)
        .ancestors()
        .nth(3)
        .ok_or("unexpected swiftc path")?;
    let meta_dir = manifest.join("gen/apple-intents");
    let _ = std::fs::remove_dir_all(meta_dir.join("Metadata.appintents"));
    run(
        Command::new(&processor)
            .arg("--output")
            .arg(&meta_dir)
            .arg("--toolchain-dir")
            .arg(toolchain)
            .args(["--module-name", MODULE, "--sdk-root", &sdk])
            .args([
                "--xcode-version",
                &xcode_build,
                "--platform-family",
                "macOS",
            ])
            .args(["--deployment-target", &min_os, "--target-triple", &triple])
            .arg("--source-file-list")
            .arg(&sources_list)
            .arg("--swift-const-vals-list")
            .arg(&const_list)
            .arg("--no-app-shortcuts-localization")
            .arg("--force"),
        "appintentsmetadataprocessor",
    )?;
    if !meta_dir
        .join("Metadata.appintents/extract.actionsdata")
        .exists()
    {
        return Err("appintentsmetadataprocessor produced no metadata".into());
    }

    let toolchain_lib = toolchain.join("usr/lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain_lib.display());
    println!("cargo:rustc-link-lib=static=comail_intents");
    println!("cargo:rustc-cfg=apple_intents");
    Ok(())
}
