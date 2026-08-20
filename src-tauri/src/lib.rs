mod commands;
mod progress_parser;
mod running_process;
mod stream_processor;
mod types;
mod utils;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::batch_commit::scan_batch_commit,
            commands::batch_commit::add_to_lfs,
            commands::batch_commit::remove_from_lfs,
            commands::batch_commit::batch_commit,
            commands::remote_build::inspect_remote_build_checkout,
            commands::remote_build::fetch_remote_build_branch,
            commands::remote_build::update_remote_build_checkout,
            commands::remote_build::clone_github_repository,
            commands::remote_build::validate_clone_destination,
            commands::remote_build::prepare_remote_build_output,
            commands::remote_build::archive_remote_build_output,
            commands::github_auth::github_start_authorization,
            commands::github_auth::github_complete_authorization,
            commands::github_auth::github_is_connected,
            commands::github_auth::github_disconnect,
            commands::github_api::github_current_account,
            commands::github_api::github_list_repositories,
            commands::github_api::github_list_branches,
            commands::github_api::github_get_branch_tip,
            commands::files::read_text_file,
            commands::registry::get_unreal_version_selector_path,
            commands::registry::get_installed_engine_paths,
            commands::registry::validate_engine_path,
            commands::registry::read_engine_version_from_path,
            commands::projects::analyse_uproject,
            commands::projects::get_project_thumbnail_path,
            commands::projects::filter_existing_paths,
            commands::projects::scan_project_maps,
            commands::ide_detection::detect_sln_ide,
            commands::ide_detection::list_installed_ides,
            commands::process::open_file,
            commands::process::get_project_folder_availability,
            commands::process::open_project_folder,
            commands::process::open_uproject_with_rider,
            commands::process::launch_ide_for_project,
            commands::process::launch_project_with_map,
            commands::process::run_command,
            commands::process::kill_process,
            commands::process::stop_running_process,
            commands::monitor::get_process_status,
            commands::monitor::has_blocking_processes,
            commands::regenerate::regenerate_project,
            commands::shader::get_shader_worker_status,
            commands::shader::set_shader_worker_priority,
            commands::umap::run_map_command,
            commands::umap::run_build_lighting,
            commands::uproject::run_cook,
            commands::uproject::get_project_version,
            commands::uproject::run_package,
            commands::uproject::run_archive,
            commands::uproject::run_build,
            commands::uproject::run_resave_packages,
            commands::plugin::list_plugins_for_project,
            commands::plugin::build_plugin,
            commands::movie_render_queue::run_movie_render_queue,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
