<p align="center"><img src="docs/banner.svg" alt="Breeze" width="820"></p>

# Breeze · 轻语

一个极简的 AI 对话客户端：Android 手机和 Windows 电脑共用同一套代码，Rust 内核，纯本地存储。

打开就是一句话的输入框，没有启动广告，没有账号体系，没有埋点。

## 它是什么

- **一个 App，两个平台**：Android APK + Windows 免安装 exe，界面是同一份。
- **三步上手**：填接口地址 → 填 API Key → 选模型，点保存就能聊。
- **三种接入方式**，覆盖绝大多数用法：
  1. **中转站** — 只填 Base URL 和 API Key，自动读取模型列表，选完即可，思考强度一档一档点。
  2. **官方平台** — 直接选 DeepSeek / OpenAI / 阿里通义 / Moonshot / 智谱，只填一个 Key。
  3. **开发者** — 自定义路径、请求头、请求体、`reasoning_effort`、`thinking`、`top_p`、`max_tokens`、超时，全都在一个面板里。
- **角色**：人设 + 知识库 + 图标，可单个聊，也可组群聊，让不同角色轮流发言。
- **角色批量导入**：粘贴或选择 JSON 文件，一次导入一批人设。
- **附件**：图片按多模态格式直传，文本文件自动内联进上下文，其他文件标注文件名。
- **流式输出**：逐字显示，思考过程单独灰字展示，随时可停。
- **一键搬家**：全部数据导出成一段 JSON（含方案、角色、对话），新设备粘贴导入即可。

API Key 只落在本机的应用数据目录，不经过任何中转服务器。

## 界面

```
对话  ·  角色  ·  设置
```

- 对话：列表 → 点开即聊，右上角新建。
- 角色：新建人设 / 建群 / 导入 JSON。
- 设置：管理模型方案、导出导入备份。

## 下载

到 [Releases](../../releases) 取最新构建：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Android | `Breeze-android.apk` | Android 8.0+，arm64 / armv7 |
| Windows | `Breeze-windows.zip` | 解压后双击 `Breeze.exe` |

Windows 版依赖系统自带的 WebView2（Win10/11 默认已安装）。

## 自己编译

需要 Rust、Node.js（仅用于 Tauri CLI）。

```bash
cargo install tauri-cli --version "^2"
npm i -g @tauri-apps/cli

# Windows / macOS / Linux 桌面版
cd src-tauri && cargo build --release
# 产物：src-tauri/target/release/breeze

# Android（需 Android SDK + NDK 27 + JDK 17）
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
tauri android build --apk
```

Android 打包签名：在 `src-tauri/gen/android/keystore.properties` 里写

```properties
storeFile=../breeze.jks
storePassword=你的密码
keyAlias=breeze
keyPassword=你的密码
```

没有这个文件时会产出未签名的 APK，可直接用于本地调试。

## 目录结构

```
ui/                     界面（原生 HTML/CSS/JS，无框架、无构建）
src-tauri/src/chat.rs   HTTP 流式请求、SSE 解析、取消
src-tauri/src/store.rs  本地数据读写、附件读取
src-tauri/gen/android/  Android 工程
```

## 角色 JSON 格式

```json
[
  {
    "name": "夜航",
    "emoji": "✈",
    "system": "你是一位冷静的夜间飞行教练，说话简短。",
    "knowledge": "可选的背景资料，会随对话一起发送。"
  }
]
```

在「角色 → 导入」里粘贴即可。

## 许可

MIT
