mod backend;
mod commands;
mod errors;
mod proxy;
mod runtime;
pub mod sidecar;
mod validation;

use proxy::{NodeSidecarBackend, TauriEventSink};
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

            // Wire the production runtime to the Node sidecar proxy.
            let sink = TauriEventSink::new(app.handle().clone());
            let backend = NodeSidecarBackend::new(SIDECAR_DEFAULT_PORT, Box::new(sink));
            let runtime = runtime::HostRuntime::with_backend(std::sync::Arc::new(backend));
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent_health,
            commands::agent_create_session,
            commands::agent_start_turn,
            commands::agent_cancel_turn,
            commands::agent_get_config,
            commands::agent_create_provider,
            commands::agent_update_provider,
            commands::agent_delete_provider,
            commands::agent_create_route,
            commands::agent_update_route,
            commands::agent_delete_route,
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
