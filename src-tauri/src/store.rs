use base64::Engine;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILES: [&str; 3] = ["config", "roles", "chats"];

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn load_all(app: AppHandle) -> Result<Value, String> {
    let dir = data_dir(&app)?;
    let mut out = serde_json::Map::new();
    for name in FILES {
        let path = dir.join(format!("{name}.json"));
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        out.insert(name.to_string(), value);
    }
    Ok(Value::Object(out))
}

#[tauri::command]
pub fn save_file(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    if !FILES.contains(&name.as_str()) {
        return Err("未知的数据文件".to_string());
    }
    let dir = data_dir(&app)?;
    let path = dir.join(format!("{name}.json"));
    let tmp = dir.join(format!("{name}.json.tmp"));
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file_text(path: String, text: String) -> Result<(), String> {
    fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file_b64(path: String) -> Result<Value, String> {
    const MAX: u64 = 20 * 1024 * 1024;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX {
        return Err("文件超过 20MB，无法附加".to_string());
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let name = PathBuf::from(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };
    let data = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(serde_json::json!({
        "name": name,
        "mime": mime,
        "ext": ext,
        "data": data
    }))
}
