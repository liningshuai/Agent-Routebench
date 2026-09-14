mod backend;
mod commands;
mod credentials;
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
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| Box::new(crate::errors::HostError::invalid_sidecar_options()))?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|_| Box::new(crate::errors::HostError::invalid_sidecar_options()))?;
    let config_path = config_dir.join("config.json");
    if !config_path.exists() {
        std::fs::write(
            &config_path,
            b"{\n  \"version\": 1,\n  \"providers\": [],\n  \"routes\": []\n}\n",
        )
        .map_err(|_| Box::new(crate::errors::HostError::invalid_sidecar_options()))?;
    }
    // Windows portable resources live beside the application executable.
    // Release builds must never execute an arbitrary Node from PATH.
    let bundled_node = resource_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node_executable = if bundled_node.is_file() {
        bundled_node
            .canonicalize()
            .map_err(|_| {
                Box::new(crate::errors::HostError::sidecar_start_failed())
                    as Box<dyn std::error::Error>
            })?
            .to_string_lossy()
            .into_owned()
    } else if cfg!(debug_assertions) {
        "node".to_owned()
    } else {
        return Err(Box::new(crate::errors::HostError::sidecar_start_failed()));
    };
    let config = SidecarLaunchConfig::new(
        node_executable,
        script_path.to_string_lossy().into_owned(),
        SIDECAR_LOOPBACK_HOST,
        SIDECAR_DEFAULT_PORT,
    )
    .and_then(|config| config.with_config_path(config_path.to_string_lossy().into_owned()))
    .map(|config| config.with_create_config_if_missing(true));
    #[cfg(windows)]
    let config = config.and_then(|config| {
        let helper = std::env::current_exe()
            .map_err(|_| crate::errors::HostError::invalid_sidecar_options())?;
        config.with_credential_helper(helper.to_string_lossy().into_owned())
    });
    let config = config.map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
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
            let backend = std::sync::Arc::new(NodeSidecarBackend::new(
                SIDECAR_DEFAULT_PORT,
                Box::new(sink),
            ));
            let runtime = runtime::HostRuntime::with_backends(backend.clone(), backend);
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
            commands::agent_set_credential,
            commands::agent_has_credential,
            commands::agent_delete_credential,
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
