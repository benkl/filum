//! Tauri shell. The editor UI and the WebAssembly engine are shared with the
//! browser build; native code adds file dialogs and filesystem access, the
//! files Filum is opened with, and one window at a time.

use std::sync::Mutex;

mod safe_write;

/// Files waiting to be opened by the editor: the ones Filum was started
/// with ("Open with Filum" or a double-click on Windows and Linux), and on
/// macOS the ones the system hands over, at launch or while it runs.
struct OpenQueue(Mutex<Vec<String>>);

/// Takes the files waiting to be opened (each one is returned once).
#[tauri::command]
fn startup_files(queue: tauri::State<OpenQueue>) -> Vec<String> {
    std::mem::take(&mut *queue.0.lock().unwrap())
}

/// Saves a file the user chose (the bytes are the request body, the name is in
/// the `path` header): written next to it first, then put in its place, so a
/// save that is cut off never leaves a half-written file.
#[tauri::command]
fn save_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file: the file's bytes are missing".into());
    };
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .and_then(safe_write::decode_path)
        .ok_or("save_file: no file name")?;
    safe_write::write_replacing(std::path::Path::new(&path), bytes).map_err(|e| format!("{path}: {e}"))
}

/// The files among command-line arguments (a file name that isn't valid
/// Unicode is passed on as well as it can be, rather than stopping the start).
/// `cwd`: the folder relative names are in, when it isn't this process's own
/// (a second launch hands its arguments to the running Filum).
fn files_in<I: IntoIterator<Item = std::ffi::OsString>>(args: I, cwd: Option<&std::path::Path>) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .map(|a| match cwd {
            Some(dir) => dir.join(&a),
            None => std::path::PathBuf::from(a),
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn launch_files() -> Vec<String> {
    files_in(std::env::args_os(), None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // one Filum at a time: a file opened while it runs goes to the open
        // window (two windows would share, and overwrite, one autosave)
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            use tauri::{Emitter, Manager};
            // relative names are in the second launch's folder, not ours
            // (joining keeps an absolute name as it is)
            let paths = files_in(argv.into_iter().map(std::ffi::OsString::from), Some(std::path::Path::new(&cwd)));
            if !paths.is_empty() {
                app.state::<OpenQueue>().0.lock().unwrap().extend(paths);
                let _ = app.emit("open-files", ());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(OpenQueue(Mutex::new(launch_files())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![startup_files, save_file])
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
