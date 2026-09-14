// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = credentials::helper_exit_code(&args) {
        std::process::exit(code);
    }
    agent_routebench_lib::run();
}
