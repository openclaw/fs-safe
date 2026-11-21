fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
    let flags = std::env::var("CARGO_ENCODED_RUSTFLAGS")
        .expect("Cargo must provide the resolved target Rust flags");
    let encoded: String = flags.bytes().map(|byte| format!("{byte:02x}")).collect();
    println!("cargo:rustc-env=FS_SAFE_CONFIGURED_RUSTFLAGS_HEX={encoded}");
}
