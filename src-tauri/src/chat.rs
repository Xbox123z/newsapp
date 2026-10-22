use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub stream: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub thinking: Option<Value>,
    pub extra_headers: Option<HashMap<String, String>>,
    pub extra_body: Option<Value>,
    #[serde(default)]
    pub exact_path: Option<String>,
    pub timeout_secs: Option<u64>,
}

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(id.to_string(), flag.clone());
    flag
}

fn unregister(id: &str) {
    if let Ok(mut map) = cancels().lock() {
        map.remove(id);
    }
}

#[tauri::command]
pub fn chat_cancel(id: String) {
    if let Some(flag) = cancels().lock().ok().and_then(|m| m.get(&id).cloned()) {
        flag.store(true, Ordering::SeqCst);
    }
}

fn has_api_version(url: &str) -> bool {
    url.split('/').any(|seg| {
        seg.len() > 1
            && seg.starts_with('v')
            && seg[1..].chars().all(|c| c.is_ascii_digit())
    })
}

fn endpoint(base: &str, exact: Option<&str>, suffix: &str) -> String {
    if let Some(p) = exact {
        let p = p.trim();
        let root = base.trim().trim_end_matches('/');
        if p.starts_with("http://") || p.starts_with("https://") {
            return p.to_string();
        }
        return format!("{}{}", root, if p.starts_with('/') { p.to_string() } else { format!("/{p}") });
    }
    let mut url = base.trim().trim_end_matches('/').to_string();
    if !has_api_version(&url) {
        url.push_str("/v1");
    }
    format!("{url}{suffix}")
}

fn build_client(timeout_secs: Option<u64>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(20));
    if let Some(t) = timeout_secs {
        if t > 0 {
            builder = builder.timeout(std::time::Duration::from_secs(t));
        }
    }
    builder.build().unwrap_or_default()
}

fn apply_headers(req: reqwest::RequestBuilder, key: &str, extra: &Option<HashMap<String, String>>) -> reqwest::RequestBuilder {
    let mut req = req;
    if !key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", key.trim()));
    }
    if let Some(map) = extra {
        for (k, v) in map {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    req
}

#[tauri::command]
pub async fn list_models(
    base_url: String,
    api_key: String,
    exact_path: Option<String>,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<Vec<String>, String> {
    let url = endpoint(&base_url, exact_path.as_deref(), "/models");
    let client = build_client(Some(30));
    let req = apply_headers(client.get(&url), &api_key, &extra_headers);
    let resp = req.send().await.map_err(|e| format!("无法连接: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {}", trim_text(&text, 300)));
    }
    let body: Value = resp.json().await.map_err(|e| format!("返回不是 JSON: {e}"))?;
    let list = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    for item in list {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

#[tauri::command]
pub fn chat_start(app: AppHandle, req: ChatRequest) -> Result<(), String> {
    let ChatRequest {
        id,
        base_url,
        api_key,
        model,
        messages,
        stream,
        temperature,
        top_p,
        max_tokens,
        reasoning_effort,
        thinking,
        extra_headers,
        extra_body,
        exact_path,
        timeout_secs,
    } = req;

    let flag = register(&id);
    let url = endpoint(&base_url, exact_path.as_deref(), "/chat/completions");

    let mut body = json!({ "model": model, "messages": messages, "stream": stream });
    if let Some(v) = temperature {
        body["temperature"] = json!(v);
    }
    if let Some(v) = top_p {
        body["top_p"] = json!(v);
    }
    if let Some(v) = max_tokens {
        body["max_tokens"] = json!(v);
    }
    if let Some(v) = reasoning_effort {
        body["reasoning_effort"] = json!(v);
    }
    if let Some(v) = thinking {
        body["thinking"] = v;
    }
    if let Some(extra) = extra_body {
        if let (Some(base_map), Some(extra_map)) = (body.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_map {
                base_map.insert(k.clone(), v.clone());
            }
        }
    }

    let client = build_client(timeout_secs.or(if stream { None } else { Some(300) }));
    let request = apply_headers(client.post(&url), &api_key, &extra_headers).json(&body);

    tauri::async_runtime::spawn(async move {
        run_stream(app, id, request, stream, flag).await;
    });
    Ok(())
}

async fn run_stream(app: AppHandle, id: String, request: reqwest::RequestBuilder, stream: bool, flag: Arc<AtomicBool>) {
    match request.send().await {
        Err(e) => {
            emit(&app, &id, &json!({ "type": "error", "message": format!("无法连接: {e}") }));
            unregister(&id);
        }
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                emit(
                    &app,
                    &id,
                    &json!({ "type": "error", "message": format!("接口返回 {status}：{}", trim_text(&text, 400)) }),
                );
                unregister(&id);
                return;
            }
            let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();

            if stream && ctype.contains("event-stream") {
                stream_sse(&app, &id, resp, &flag).await;
            } else {
                let text = resp.text().await.unwrap_or_default();
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) => {
                        let choice = v.get("choices").and_then(|c| c.get(0));
                        let content = choice
                            .and_then(|c| c.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        let reasoning = choice
                            .and_then(|c| c.get("message"))
                            .and_then(|m| m.get("reasoning_content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        if !reasoning.is_empty() {
                            emit(&app, &id, &json!({ "type": "reasoning", "text": reasoning }));
                        }
                        emit(&app, &id, &json!({ "type": "delta", "text": content }));
                        emit(&app, &id, &json!({ "type": "done" }));
                    }
                    Err(_) => {
                        emit(&app, &id, &json!({ "type": "error", "message": format!("返回不是 JSON：{}", trim_text(&text, 400)) }));
                    }
                }
            }
            unregister(&id);
        }
    }
}

async fn stream_sse(app: &AppHandle, id: &str, resp: reqwest::Response, flag: &Arc<AtomicBool>) {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut got_any = false;

    while let Some(chunk) = stream.next().await {
        if flag.load(Ordering::SeqCst) {
            emit(app, id, &json!({ "type": "done", "cancelled": true }));
            return;
        }
        match chunk {
            Err(e) => {
                emit(app, id, &json!({ "type": "error", "message": format!("连接中断: {e}") }));
                return;
            }
            Ok(bytes) => {
                buf.extend_from_slice(&bytes);
                while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim().trim_end_matches('\r');
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim();
                    if data == "[DONE]" {
                        emit(app, id, &json!({ "type": "done" }));
                        return;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                    let choice = v.get("choices").and_then(|c| c.get(0));
                    if let Some(reasoning) = choice.and_then(|c| c.get("delta")).and_then(|d| d.get("reasoning_content")).and_then(|c| c.as_str()) {
                        if !reasoning.is_empty() {
                            got_any = true;
                            emit(app, id, &json!({ "type": "reasoning", "text": reasoning }));
                        }
                    }
                    if let Some(text) = choice.and_then(|c| c.get("delta")).and_then(|d| d.get("content")).and_then(|c| c.as_str()) {
                        if !text.is_empty() {
                            got_any = true;
                            emit(app, id, &json!({ "type": "delta", "text": text }));
                        }
                    }
                }
            }
        }
    }
    if got_any {
        emit(app, id, &json!({ "type": "done" }));
    } else {
        emit(app, id, &json!({ "type": "error", "message": "服务端没有返回任何内容，请检查模型名与参数" }));
    }
}

fn emit(app: &AppHandle, id: &str, payload: &Value) {
    let data = json!({ "id": id, "event": payload });
    let _ = app.emit("breeze://chat", data);
}

fn trim_text(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}
