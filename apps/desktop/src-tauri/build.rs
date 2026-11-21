fn main() {
    // Embed ZOTERO credentials at compile time from .env file or system env
    let _ = dotenvy::dotenv(); // load .env if present (local dev)
    for key in ["ZOTERO_CONSUMER_KEY", "ZOTERO_CONSUMER_SECRET"] {
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
    }

    // On Linux, apply a version script to hide statically linked ICU/HarfBuzz/
    // FreeType/Fontconfig symbols from the dynamic symbol table.  This prevents
    // symbol collisions with the system copies loaded by WebKit2GTK (segfault).
    // See: https://github.com/delibae/claude-prism/issues/100
    #[cfg(target_os = "linux")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        println!(
            "cargo:rustc-link-arg=-Wl,--version-script={}/symbols.map",
            manifest_dir
        );
        // Tectonic's semi-static pkg-config build also links GLib, expat, etc.
        // statically.  ld auto-exports any definition referenced by a shared
        // library at link time, so libgtk/libgio/Mesa end up binding to *our*
        // static copies instead of the system ones -> heap corruption in
        // gtk_init (#204) and a segfault in Mesa's driconf parser (#213).
        // Never export symbols that come from static archives; the executable
        // has no legitimate reason to provide symbols to shared libraries.
        println!("cargo:rustc-link-arg-bins=-Wl,--exclude-libs,ALL");
        println!("cargo:rerun-if-changed=symbols.map");
    }

    tauri_build::build()
}
