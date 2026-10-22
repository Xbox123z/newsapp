mod chat;
mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            store::load_all,
            store::save_file,
            store::read_file_text,
            store::write_file_text,
            store::read_file_b64,
            chat::list_models,
            chat::chat_start,
            chat::chat_cancel
        ])
        .run(tauri::generate_context!())
        .expect("Breeze 启动失败");
}
