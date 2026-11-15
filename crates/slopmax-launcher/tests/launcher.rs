//! `slopmaxw` as Windows runs it from the Run key. Having this test also
//! makes `cargo test` build the binary beside `slopmax`, where the CLI's
//! Windows service test needs it.

use std::process::Command;

#[test]
fn a_command_line_it_cannot_read_ends_it() {
    let launcher = env!("CARGO_BIN_EXE_slopmaxw");
    let status = Command::new(launcher).status().unwrap();
    assert_eq!(status.code(), Some(2));
    let status = Command::new(launcher)
        .args(["slopmax.exe", "extra.exe", "--log", "l"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
}

#[test]
fn it_stops_once_the_proxy_exits_cleanly() {
    // A stand-in for a proxy that stops cleanly: this test binary, which
    // the launcher runs as `<it> serve`, takes `serve` as a filter that no
    // test here matches (keep it that way), runs nothing and exits 0.
    let me = std::env::current_exe().unwrap();
    let log = std::env::temp_dir().join(format!("slopmaxw-{}.log", std::process::id()));
    let status = Command::new(env!("CARGO_BIN_EXE_slopmaxw"))
        .arg(&me)
        .arg("--log")
        .arg(&log)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
    let _ = std::fs::remove_file(&log);
}
