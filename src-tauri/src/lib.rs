//! Tauri shell. The editor UI and the WebAssembly engine are shared with the
//! browser build; native code adds file dialogs/filesystem access plus a few
//! commands that run the same Rust engine natively (fast batch export).

use std::sync::Mutex;

use filum_core::{io, Document, Engine};

/// Export a document (JSON) straight to a file using the native engine.
#[tauri::command]
fn export_native(doc_json: String, path: String, pes_version: Option<u32>) -> Result<usize, String> {
    let doc: Document = serde_json::from_str(&doc_json).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("dst").to_string();
    let opts = io::ExportOptions { pes_version: pes_version.unwrap_or(1), ..Default::default() };
    let bytes = io::export_with(&doc, &mut Engine::new(), &ext, &opts)?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len())
}

/// Files waiting to be opened by the editor: the ones Filum was started
/// with ("Open with Filum" or a double-click on Windows and Linux), and on
/// macOS the ones the system hands over, at launch or while it runs.
struct OpenQueue(Mutex<Vec<String>>);

/// Takes the files waiting to be opened (each one is returned once).
#[tauri::command]
fn startup_files(queue: tauri::State<OpenQueue>) -> Vec<String> {
    std::mem::take(&mut *queue.0.lock().unwrap())
}

fn launch_files() -> Vec<String> {
    std::env::args().skip(1).filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file()).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OpenQueue(Mutex::new(launch_files())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![export_native, startup_files])
        .build(tauri::generate_context!())
        .expect("error while running Filum");
    app.run(|_app, _event| {
        // macOS (and mobile) pass opened files as an event, not as arguments
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            use tauri::{Emitter, Manager};
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                _app.state::<OpenQueue>().0.lock().unwrap().extend(paths);
                let _ = _app.emit("open-files", ());
            }
        }
    });
}
