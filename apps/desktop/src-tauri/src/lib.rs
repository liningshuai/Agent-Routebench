mod backend;
mod commands;
mod errors;
mod runtime;
mod validation;

pub fn run() {
    tauri::Builder::default()
        .manage(HostRuntime::not_ready())
        .invoke_handler(tauri::generate_handler![
            commands::agent_health,
            commands::agent_create_session,
            commands::agent_start_turn,
            commands::agent_cancel_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the tauri host");
}

use runtime::HostRuntime;
