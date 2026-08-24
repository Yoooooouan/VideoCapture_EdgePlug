# 视频抓取助手 - Edge 浏览器插件

> 抓取当前网页视频（B 站、抖音等），支持清晰度选择、音频提取、预览与下载。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 🎬 多站点支持 | B 站（b站/哔哩哔哩）、抖音、以及所有 HLS/DASH/直链站点 |
| 📡 智能抓取 | `webRequest` 拦截 + `<video>` 元素检测 + B 站 `__playinfo__` 提取 |
| 🔄 页面刷新 | 切换网页后自动清空，仅显示当前页面视频 |
| 📺 清晰度选择 | HLS 主播放列表解析、B 站 playinfo 4K/1080P/720P... |
| 🎵 仅音频提取 | MP3（128/192/320 kbps）、WAV（无损 16-bit）、FLAC（无损，源为 FLAC 时直接保存） |
| 👁 在线预览 | 弹窗内可对直接链接进行试播（blob/HLS 不支持预览） |
| 💾 文件命名 | 自动用视频标题命名，清理非法字符，截断为 100 字符 |
| 📦 输出格式 | 视频默认 `.mp4`、音频默认 `.mp3`、FLAC 直存 `.flac` |

## 安装方法

### Edge 加载本地扩展

1. 打开 Edge 浏览器，地址栏输入 `edge://extensions/`
2. 打开右下角「开发人员模式」开关
3. 点击「加载解压缩的扩展」
4. 选择本项目根目录（包含 `manifest.json` 的目录）
5. 安装完成，工具栏会出现 📹 图标

> 仅需加载一次即可。每次重新打开 Edge 时扩展会自动启用。

## 使用方法

1. 在浏览器中打开目标视频页面（例：哔哩哔哩 `https://www.bilibili.com/video/BVxxxx`）
2. 等待视频开始播放，确保页面有视频流量
3. 点击工具栏的 📹 图标，弹出视频抓取助手窗口
4. 窗口会展示当前页面检测到的所有媒体
5. 选择清晰度 / 音频格式，点击「下载视频」或「下载音频」
6. 文件默认下载到 Edge 的默认下载目录

> **切换页面**：浏览器切换到其他网页后，弹窗里的列表会自动清空（因为旧数据已不再属于当前页面）。需要重新点击 📹 拉取新页面数据。

## 工作原理

```
┌────────────────────┐  webRequest  ┌────────────────────┐
│  当前页面 (Bilibili)│ ──拦截 m3u8/  │  background.js     │
│                    │   m4s/mp4 URL │  (service worker)  │
│  <video> 元素      │               │                    │
│  + __playinfo__    │ ──chrome.     │  - M3U8 解析       │
│                    │   scripting   │  - DASH playinfo   │
└────────────────────┘   (MAIN world) │  - 分段下载合并    │
                                      │  - 音频编码        │
                                      │  - 下载管理        │
                                      │        │           │
                                      │        ▼ 渲染 UI   │
                                      │  ┌──────────────┐  │
                                      │  │ popup.html   │  │
                                      │  │ 视频卡片列表  │  │
                                      │  │ 清晰度/格式   │  │
                                      │  │ 预览/下载    │  │
                                      │  └──────────────┘  │
                                      │        │           │
                                      │        ▼ 音频提取  │
                                      │  ┌──────────────┐  │
                                      │  │ offscreen    │  │
                                      │  │ + lamejs     │  │
                                      │  └──────────────┘  │
                                      └────────────────────┘
```

## 关键实现细节

### 1. M3U8 视频流下载
- 解析主播放列表（master playlist）→ 获取各清晰度变体
- 选择清晰度后获取媒体播放列表（media playlist）
- 逐段 `fetch` 下载 + 拼接
- 若有 `#EXT-X-MAP`（fMP4 init segment）→ 拼接 init + 媒体分段，输出 `.mp4`
- 否则输出 `.ts`（可改后缀播放）

### 2. B 站 DASH 视频下载
- 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 访问页面 `window.__playinfo__`
- 若无 `__playinfo__`，从 `window.__INITIAL_STATE__` 拿 bvid/cid，调用 B 站官方 `playurl` API（`fnval=80`）
- 视频流和音频流分离开来
- 通过 `declarativeNetRequest` 自动注入 `Referer: https://www.bilibili.com`，绕过 CDN 防盗链
- 「下载视频」得到纯视频 `.mp4`（无音频），「下载音频」从 m4s 流中转码为 MP3/WAV

### 3. 音频提取与编码
- **快速路径**：`AudioContext.decodeAudioData()` 解码 m4a/m4s/mp4 等容器
- **兜底路径**：用 `<video>` 元素 + `MediaElementAudioSourceNode` + `ScriptProcessorNode` 实时捕获 PCM
- **MP3 编码**：`lamejs` 库（`lame.min.js`，约 150KB）按 1152 样本/帧编码
- **WAV 编码**：手写 44 字节 RIFF/WAVE 头 + 16-bit PCM
- **FLAC**：源为 FLAC 流直接保存；否则用 WAV 作为无损替代

## 文件结构

```
VideoCapture_EdgePlug/
├── manifest.json           # MV3 配置
├── background.js           # Service Worker（核心逻辑 ~900 行）
├── content/
│   └── content.js          # 注入到所有页面
├── popup/
│   ├── popup.html          # 弹窗 UI
│   ├── popup.css           # 弹窗样式
│   └── popup.js            # 弹窗逻辑
├── offscreen/
│   ├── offscreen.html      # 离屏文档（音频处理）
│   └── offscreen.js        # 音频提取/编码
├── lib/
│   └── lame.min.js         # MP3 编码库（lamejs）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 已知限制

| 限制 | 说明 | 原因 |
| --- | --- | --- |
| 加密 HLS | 不支持 `#EXT-X-KEY` 加密的 HLS | 需要解密密钥流 |
| FLAC 转码 | 源非 FLAC 时输出 WAV | 浏览器无原生 FLAC 编码器，WAV 同样无损 |
| 视频+音频合并（B 站） | 需分别下载后用 ffmpeg 合并 | 无 ffmpeg.wasm 体积大；B 站 DASH 天然分轨 |
| HLS 在线预览 | 弹窗内不显示预览 | 需引入 hls.js 库；可下载后查看 |
| Blob URL 抓取 | 不支持 blob:// 协议 | 跨上下文无法获取原始分片 |

## 调试

打开 `edge://extensions/` → 点击「服务工作线程」旁边的「检查视图」打开 DevTools，可看到 background 端日志。
弹窗本身右键 → 检查，可看到 popup 端日志。
