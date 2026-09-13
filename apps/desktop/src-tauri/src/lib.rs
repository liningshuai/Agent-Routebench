mod backend;
mod commands;
mod errors;
mod runtime;
pub mod sidecar;
mod validation;

use sidecar::{
    NodeHostSupervisor, SidecarLaunchConfig, SIDECAR_DEFAULT_PORT, SIDECAR_LOOPBACK_HOST,
};
use tauri::{Manager, RunEvent};

fn create_sidecar_supervisor(
    app: &tauri::App,
) -> Result<NodeHostSupervisor, Box<dyn std::error::Error>> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| Box::new(crate::errors::HostError::invalid_sidecar_options()))?;
    let script_path = resource_dir
        .join("local-agent-host")
        .join("dist")
        .join("main.js");
    let config = SidecarLaunchConfig::new(
        "node",
        script_path.to_string_lossy().into_owned(),
        SIDECAR_LOOPBACK_HOST,
        SIDECAR_DEFAULT_PORT,
    )
    .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
    let supervisor = NodeHostSupervisor::new(config);
    supervisor
        .start()
        .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
    Ok(supervisor)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let supervisor = create_sidecar_supervisor(app)?;
            app.manage(supervisor);
            Ok(())
        })
        .manage(HostRuntime::not_ready())
        .invoke_handler(tauri::generate_handler![
            commands::agent_health,
            commands::agent_create_session,
            commands::agent_start_turn,
            commands::agent_cancel_turn,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the tauri host")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(supervisor) = app_handle.try_state::<NodeHostSupervisor>() {
                    let _ = supervisor.stop();
                }
            }
        });
}

use runtime::HostRuntime;
