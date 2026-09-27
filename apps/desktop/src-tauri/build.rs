fn main() {
    // The embedded build number must follow the environment of each release build.
    println!("cargo:rerun-if-env-changed=CHORDV_BUILD_NUMBER");
    tauri_build::build()
}
