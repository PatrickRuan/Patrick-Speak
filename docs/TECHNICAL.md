# 技術說明文件 — Patrick Speak

本文件說明 Patrick Speak 的內部運作、設計決策與資料流，供想理解或擴充程式的人參考。

---

## 1. 技術棧總覽

| 層 | 技術 | 為什麼選它 |
|----|------|-----------|
| 後端框架 | **FastAPI** + **Uvicorn** | 非同步、輕量、自動處理 JSON；`async` 適合等待 Ollama / 子程序 |
| 影音下載 | **yt-dlp** | 最活躍的 YouTube 下載工具，支援切換 client 繞過驗證 |
| 音訊處理 | **ffmpeg** | 業界標準，負責格式轉換與切段 |
| 語音轉文字 | **whisper.cpp** | OpenAI Whisper 的 C++ 實作，Apple Silicon 上走 Metal 加速、離線 |
| 翻譯 | **Ollama** | 本地 LLM 執行平台，HTTP API 簡單，免雲端金鑰 |
| 前端 | **原生 HTML/CSS/JS** | 無建置流程，降低相依與學習門檻 |
| 快取 | **檔案系統 (JSON + mp3)** | 簡單可靠，免資料庫 |

---

## 2. 後端資料流（backend/main.py）

核心端點：`POST /api/process`，輸入 `{ "url": "...", "full": false }`，回傳整套教材 JSON。

```
process_video(url, full=False)
│
├─ video_id = md5(url)[:12]              # 以網址雜湊當快取鍵
│
├─ 若 _result.json 存在 ───────────────▶ 回傳完整快取（秒開，超集優先）
├─ 若 (非 full) 且 _result_partial.json 存在 ▶ 回傳部分快取
│
├─ 並行保險：若已有影片處理中 → 回 409
│
├─ download_audio()                      # yt-dlp + android client → {id}.mp3
│     -f "bestaudio/best"                # 適應不同影片的格式後備
├─ get_media_duration()                  # ffprobe 取整支長度
├─ get_video_title()                     # yt-dlp 取標題（存 _meta.json）
│
├─ limit = None(full) / PREVIEW_SECONDS(預設 360 秒)
├─ transcribe_audio(limit)              # 本地語音轉文字（可只轉前 limit 秒）
│     ├─ ffmpeg → 16kHz 單聲道 wav (-t limit)
│     ├─ whisper-cli -oj                # 帶毫秒時間戳的 JSON
│     └─ split_into_sentences()         # 片段 → 完整句子
│
├─ split_into_segments()                # 句子 → 每 ~120 秒一段
│
├─ trans_cache = load_trans_cache()     # 讀該影片的英→中翻譯快取
└─ 逐段：
      ├─ split_audio_segment()          # ffmpeg 依時間切出該段 mp3
      ├─ translate_texts(cache)         # 只翻快取中沒有的句子（增量）
      ├─ save_trans_cache()             # 逐段存，中斷不白費
      └─ 組裝句子（含相對時間戳）
   寫入 _result.json(full) 或 _result_partial.json，並 save_meta()
```

### 端點總覽

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/process` | 處理影片（`full` 決定前 6 分鐘或整支） |
| `GET` | `/api/audio/{video_id}/{seg_idx}` | 回傳某段的 mp3 |
| `GET` | `/api/library` | 列出所有已處理影片（讀 `_meta.json`） |
| `DELETE` | `/api/library/{video_id}` | 真刪除該影片所有快取檔（含 ID 驗證） |
| `GET` | `/` | 由 `StaticFiles` 掛載 `frontend/` 直接 serve 前端 |

---

## 3. 關鍵設計決策

### 3.1 為什麼用 Whisper，而不是 YouTube 字幕？

最初的設計是抓 YouTube 字幕，但實作中踩到兩個硬傷：

1. **登入驗證牆**：YouTube 會要求 cookies 驗證「你不是機器人」，而讀取瀏覽器 cookies 在 macOS 上會觸發鑰匙圈授權，等於把解密整個瀏覽器 cookie 的金鑰交給工具——**資安上不可接受**。
2. **字幕不一定存在或為英文**：許多影片只有自動翻譯的他國語字幕，**原始英文字幕反而抓不到**；格式（json3 / vtt）也不統一。

改用 Whisper 本地轉錄後，這兩個問題一次解決：不需登入、不碰 cookies、任何有英文語音的影片都能用。這是本專案最關鍵的架構轉折。

### 3.2 android 客戶端繞過驗證

`yt-dlp --extractor-args "youtube:player_client=android"` 模擬 YouTube App 的請求，多數公開影片可免 cookies 取得音訊。搭配 `-f "bestaudio/best"`：優先抓純音訊，若被擋則退而取「影音合一」的舊格式（如 format 18），再由 ffmpeg 抽音訊，對不同影片有韌性。

### 3.3 片段 → 完整句子（split_into_sentences）

Whisper 輸出的是**語音片段**（phrase），常從句子中間切斷，例如 `"...which was a"` / `"boomer and..."`。直接拿來當「單句」既不利於閱讀，也讓翻譯失準。

`split_into_sentences()` 的作法：
- 累積片段文字，遇到句末標點 `.!?`（可含結尾引號／括號）即斷句。
- **片段內部**若含句末標點也會斷，斷句時間在該片段時間範圍內**按字數比例估算**，避免多句被併成一大段。

誤差被限制在「單一片段時長（約數秒）」內按比例分配，對重複播放足夠精確。

### 3.4 逐句翻譯而非整批

曾嘗試「一次給整段、要求模型保留編號」批次翻譯，但翻譯型模型會**重新斷句、重排**，導致中英對齊錯位。

最終改為**逐句一次 API 呼叫**，從根本保證中英一對一。代價是呼叫次數多，因此用 `asyncio.Semaphore(4)` 做**有限併發**隱藏延遲。權衡：犧牲少量跨句上下文（個別片段句可能略失準），換取整體對齊穩定。改進方向見 ROADMAP 的「上下文翻譯」。

### 3.5 切段策略（split_into_segments）

以句子為單位累積，當「該段已達 ~120 秒」且「至少含 3 句」時切段；尾端不足 3 句者併入前一段，避免產生過短的零碎段落。

### 3.6 預設 6 分鐘 + 全部下載（部分處理）

長片完整處理（尤其翻譯）很耗時，等待體驗差。因此預設只處理前 `PREVIEW_SECONDS`（360 秒）：

- **部分模式**：whisper 只轉錄前 6 分鐘（ffmpeg `-t` 裁切 wav），只翻譯這段 → 從 ~2.5 分鐘縮到 ~1 分鐘內。結果存 `_result_partial.json`，標記 `partial: true` 並附 `total_duration`。
- **全部下載**（`full: true`）：轉錄整支、翻譯全部，存 `_result.json`，並清掉部分產物（`_result_partial.json`、`_subs_partial.json`、舊 `_seg*.mp3`）重新乾淨產生。
- 回傳時 `_result.json`（完整）一律優先於 `_result_partial.json`（部分）。

### 3.7 增量翻譯快取（_trans.json）

翻譯是最貴的環節。每支影片維護一份 `{英文: 中文}` 快取（`_trans.json`）。`translate_texts()` 只對快取中沒有的句子呼叫 Ollama，翻完即合併回存。

效果：按「全部下載」補完剩餘時，**前 6 分鐘已翻的句子完全不重翻**（實測 78→302 句，前 78 句重用）。同時也讓影片內重複句子免重翻。

### 3.8 並行保險與容錯

- **並行保險**：模組層級的 `_processing_ids` 集合，全域同時只允許處理一支影片，第二個請求回 `409`。避免同時開多支互相搶記憶體頻寬而拖垮（事件迴圈單執行緒，「檢查→加入」之間無 `await`，是原子操作，無 race）。
- **單句容錯**：`translate_one()` 包 try/except，任何單句失敗（逾時、Ollama 錯誤）只回空字串、跳過該句，**不讓單句拖垮整批**。逐句逾時上限 180 秒。
- **巨句保護**：`split_into_sentences` 設 `MAX_SENTENCE_CHARS=220`，長時間無句末標點時強制斷句，避免產生需極久翻譯的怪獸句。
- **前端錯誤處理**：對非 JSON 的錯誤回應（如純文字 `Internal Server Error`）也能優雅顯示，不會 `JSON.parse` 失敗。

---

## 4. 翻譯模型的選擇與權衡

翻譯品質、速度、信任三者需取捨：

| 模型 | 中文品質 | 速度 | 備註 |
|------|----------|------|------|
| `translategemma` | 良好、用詞自然 | 快 | 專為翻譯訓練，本專案預設 |
| `gemma3:12b` | 不錯 | 中 | Google 通用模型，非中國來源，16GB 機器友善 |
| `qwen2.5` / `qwen3` 系列 | 最自然、最懂中文語境 | 中 | 部分使用者對中國模型有資安顧慮（即使本地執行、不連網，仍有人不放心） |

> **資安觀點**：所有模型都在本地執行、不連外網，理論上無資料外洩風險。但「信任」也包含主觀感受——若你或你的使用者對特定來源模型有疑慮，選 Gemma 系列是合理選擇。本專案把模型設成可由 `.env` 一行切換，正是為了讓這個選擇權留給使用者。

切換方式：`.env` 設定 `OLLAMA_MODEL=你要的模型名`，重啟即可。

---

## 5. 效能特性

- **Whisper 轉錄**：Apple Silicon + Metal 上，`small.en` 約可達「實際時長的數十分之一」（實測 30 秒音訊約 1.3 秒轉完）。
- **翻譯**：取決於模型與記憶體。記憶體充足時，每句約 0.5–0.6 秒；一支約 280 句的影片，完整流程（含模型冷啟動）約 3 分鐘。
- **記憶體競爭陷阱**：本地模型共用「統一記憶體」。若背景另有大型模型（如 30B），會搶頻寬使翻譯慢數十倍。`api/ps` 只顯示 Ollama 自己的模型，**看不到**其他平台（如獨立 mlx server）的佔用——排查慢速時要看「整台機器」的記憶體，而非只看 Ollama。

---

## 6. 快取設計

所有產物以 `video_id` 為前綴存在 `audio_cache/`：

| 檔案 | 內容 |
|------|------|
| `{id}.mp3` | 原始下載音訊 |
| `{id}_16k.wav` | Whisper 用的 16kHz wav |
| `{id}_whisper.json` | Whisper 原始輸出（片段 + 時間戳） |
| `{id}_subs.json` | 完整轉錄切句後的句子 |
| `{id}_subs_partial.json` | 部分（前 6 分鐘）轉錄切句後的句子 |
| `{id}_seg{n}.mp3` | 各段切出的音訊 |
| `{id}_trans.json` | 英→中翻譯快取（增量重用的關鍵） |
| `{id}_result.json` | 完整結果（命中即秒開） |
| `{id}_result_partial.json` | 部分結果（前 6 分鐘） |
| `{id}_meta.json` | 影片庫用：標題、url、總長度、partial、更新時間 |

清快取：刪除對應檔案、整個 `audio_cache/`，或前端影片庫的 ✕（呼叫 `DELETE /api/library/{id}`，會以 `{id}*` 前綴一次刪除該影片所有檔）。

---

## 6b. 前端狀態（localStorage）

前端為純 HTML/CSS/JS，使用者偏好都存在瀏覽器 localStorage：

| 鍵 | 內容 |
|----|------|
| `ps_theme` | `dark` / `light` 主題 |
| `ps_speed` | 播放速度（0.75 / 1 / 1.25） |
| `ps_favorites` | 最愛句子陣列（含 videoId、url、title、seg/sent index、en、zh） |
| `ps_lib_order` | 影片庫的自訂排序（video_id 陣列） |

影片庫的「內容」來自後端 `/api/library`（即磁碟上的 `_meta.json`），但「顯示順序」由前端 `ps_lib_order` 決定；最愛則完全存在前端。

---

## 7. 已知限制

- 逐句翻譯缺跨句上下文，少數代名詞／省略句可能略失準。
- 句子時間戳為「片段內按字數比例」估算，非逐字對齊，極短句邊界可能有零點幾秒誤差。
- 依賴 yt-dlp 對 YouTube 的相容性，YouTube 改版時可能需 `yt-dlp -U` 更新。
- 會員限定、地區封鎖、強制 SABR 串流的影片可能無法下載。

---

## 8. 專案結構

```
Patrick-Speak/
├── backend/
│   ├── __init__.py
│   └── main.py            # 全部後端邏輯（API、whisper、翻譯、快取）
├── frontend/
│   ├── index.html         # 介面骨架（主內容 + 右側側欄）
│   ├── style.css          # 樣式（含亮/暗主題）
│   └── app.js             # 播放／聽寫／影片庫／最愛／速度／主題
├── models/
│   └── ggml-small.en.bin  # Whisper 模型（需自行下載）
├── audio_cache/           # 自動產生的快取（已 gitignore）
├── docs/                  # 說明文件
├── .claude/launch.json    # 預覽伺服器設定（開發用，可選）
├── requirements.txt
├── .env.example
└── README.md
```
