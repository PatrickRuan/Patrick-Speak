# 讓 `X | None` 這類 PEP 604 型別標註在 Python 3.9 也能安全執行
# （延遲求值，不需要真的支援該語法的直譯器）
from __future__ import annotations

import os
import json
import time
import hashlib
import subprocess
import re
import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    """前端檔案（html/js/css）一律不快取、每次重新確認，
    避免改了程式但瀏覽器還在用舊版（不影響音訊等其他檔案的快取）。"""
    response = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


BASE_DIR = Path(__file__).resolve().parent.parent
AUDIO_CACHE = BASE_DIR / "audio_cache"
AUDIO_CACHE.mkdir(exist_ok=True)

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "translategemma:latest")
COOKIES_FILE = BASE_DIR / "youtube_cookies.txt"

WHISPER_BIN = os.getenv("WHISPER_BIN", "whisper-cli")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", str(BASE_DIR / "models" / "ggml-small.en.bin"))

SEGMENT_DURATION = 120
MUSIC_SEGMENT_DURATION = 600  # 音樂靠下載歌詞、不需頻繁分段，多數歌曲一段就結束
PREVIEW_SECONDS = float(os.getenv("PREVIEW_SECONDS", "360"))  # 預設只處理前 6 分鐘


def yt_dlp_auth_args() -> list[str]:
    if COOKIES_FILE.exists():
        return ["--cookies", str(COOKIES_FILE)]
    # 用 android 客戶端繞過「確認你不是機器人」，不需 cookies、不碰鑰匙圈
    return ["--extractor-args", "youtube:player_client=android"]


class VideoRequest(BaseModel):
    url: str
    full: bool = False   # False=只處理前 PREVIEW_SECONDS 秒；True=處理整支
    music: bool = False  # True=音樂模式：整首處理、用同步歌詞取代 whisper


class SubtitleEntry:
    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text

    def to_dict(self):
        return {"start": self.start, "end": self.end, "text": self.text}


def get_video_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:12]


def _clean_field(s: str) -> str:
    s = s.strip()
    return "" if s in ("", "NA", "None") else s


def get_video_info(url: str, video_id: str) -> dict:
    """抓影片標題、頻道、以及（若有）track/artist 結構化欄位（快取於 _meta.json）。
    YouTube Music 的音樂影片通常帶有精確的 track/artist，比模糊標題更適合查歌詞。"""
    meta_path = AUDIO_CACHE / f"{video_id}_meta.json"
    if meta_path.exists():
        m = json.loads(meta_path.read_text())
        if m.get("title"):
            return {"title": m.get("title", ""), "channel": m.get("channel", ""),
                    "channel_url": m.get("channel_url", ""),
                    "track": m.get("track", ""), "artist": m.get("artist", "")}
    r = subprocess.run(
        ["yt-dlp", *yt_dlp_auth_args(), "--skip-download",
         "--print", "%(title)s", "--print", "%(channel)s",
         "--print", "%(channel_url,uploader_url)s",
         "--print", "%(track)s", "--print", "%(artist)s", url],
        capture_output=True, text=True,
    )
    lines = r.stdout.strip().split("\n")
    return {
        "title": (_clean_field(lines[0]) if len(lines) > 0 else "") or "未命名影片",
        "channel": _clean_field(lines[1]) if len(lines) > 1 else "",
        "channel_url": _clean_field(lines[2]) if len(lines) > 2 else "",
        "track": _clean_field(lines[3]) if len(lines) > 3 else "",
        "artist": _clean_field(lines[4]) if len(lines) > 4 else "",
    }


def save_meta(video_id: str, url: str, title: str, total_duration: float,
              partial: bool, channel: str = "", channel_url: str = "",
              music: bool = False, track: str = "", artist: str = "") -> None:
    (AUDIO_CACHE / f"{video_id}_meta.json").write_text(json.dumps({
        "video_id": video_id,
        "url": url,
        "title": title,
        "channel": channel,
        "channel_url": channel_url,
        "total_duration": total_duration,
        "partial": partial,
        "music": music,
        "track": track,
        "artist": artist,
        "updated_at": time.time(),
    }, ensure_ascii=False))


def download_audio(url: str, video_id: str) -> Path:
    audio_path = AUDIO_CACHE / f"{video_id}.mp3"
    if audio_path.exists():
        return audio_path
    cmd = [
        "yt-dlp",
        *yt_dlp_auth_args(),
        "-f", "bestaudio/best",
        "-x", "--audio-format", "mp3",
        "--audio-quality", "5",
        "-o", str(audio_path),
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Audio download failed: {result.stderr}")
    return audio_path


def get_media_duration(path: Path) -> float:
    """用 ffprobe 取得音訊總長度（秒），失敗則回 0。"""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(result.stdout.strip())
    except (ValueError, AttributeError):
        return 0.0


def _run_whisper(audio_path: Path, video_id: str, limit_seconds: float | None) -> list[SubtitleEntry]:
    """實際執行 whisper：ffmpeg 轉 16kHz wav（可只取前 limit_seconds 秒）→ 轉錄 → 切句。"""
    wav_path = AUDIO_CACHE / f"{video_id}_16k.wav"
    ff_cmd = ["ffmpeg", "-y", "-i", str(audio_path)]
    if limit_seconds is not None:
        ff_cmd += ["-t", str(limit_seconds)]
    ff_cmd += ["-ar", "16000", "-ac", "1", str(wav_path)]
    subprocess.run(ff_cmd, capture_output=True, text=True)

    out_prefix = AUDIO_CACHE / f"{video_id}_whisper"
    result = subprocess.run(
        [WHISPER_BIN, "-m", WHISPER_MODEL, "-oj", "-of", str(out_prefix), str(wav_path)],
        capture_output=True, text=True,
    )
    json_file = AUDIO_CACHE / f"{video_id}_whisper.json"
    if not json_file.exists():
        raise HTTPException(status_code=500, detail=f"Whisper 轉錄失敗：{result.stderr[-500:]}")

    data = json.loads(json_file.read_text())
    entries = []
    for seg in data.get("transcription", []):
        text = seg.get("text", "").strip()
        off = seg.get("offsets", {})
        if text:
            entries.append(SubtitleEntry(
                start=off.get("from", 0) / 1000.0,
                end=off.get("to", 0) / 1000.0,
                text=text,
            ))
    return split_into_sentences(entries)


def transcribe_audio(audio_path: Path, video_id: str,
                     limit_seconds: float | None = None) -> list[SubtitleEntry]:
    """用本地 whisper.cpp 把音訊轉成帶時間戳的英文字幕，不依賴 YouTube 字幕。
    limit_seconds 不為 None 時只轉錄前面那段（預設 6 分鐘的快速模式）。"""
    full_cache = AUDIO_CACHE / f"{video_id}_subs.json"          # 完整轉錄
    partial_cache = AUDIO_CACHE / f"{video_id}_subs_partial.json"  # 部分轉錄

    # 已有完整轉錄 → 直接用（部分模式則依時間過濾）
    if full_cache.exists():
        entries = [SubtitleEntry(**e) for e in json.loads(full_cache.read_text())]
        if limit_seconds is not None:
            entries = [e for e in entries if e.start < limit_seconds]
        return entries

    if limit_seconds is not None:
        if partial_cache.exists():
            return [SubtitleEntry(**e) for e in json.loads(partial_cache.read_text())]
        entries = _run_whisper(audio_path, video_id, limit_seconds)
        partial_cache.write_text(json.dumps([e.to_dict() for e in entries]))
        return entries

    # 完整模式
    entries = _run_whisper(audio_path, video_id, None)
    full_cache.write_text(json.dumps([e.to_dict() for e in entries]))
    return entries


# ===== 音樂模式：同步歌詞（唱歌對 whisper 是硬傷，改用 lrclib 的 LRC 歌詞）=====

LRCLIB_API = "https://lrclib.net/api/search"


def clean_music_title(title: str) -> str:
    """把影片標題清洗成適合查歌詞的字串：去掉 (Official Video)、[MV]、feat 等雜訊。"""
    t = re.sub(r"[\(\[（【][^\)\]）】]*[\)\]）】]", " ", title)   # 去括號內容
    t = re.sub(r"(?i)\b(official|music|video|lyrics?|audio|mv|hd|4k|live)\b", " ", t)
    t = re.sub(r"[|｜/]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def is_english_lyrics(text: str) -> bool:
    """粗略判斷歌詞是否為英文：拉丁字母佔比要夠高。"""
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 40:
        return False
    ascii_letters = sum(1 for c in letters if c.isascii())
    return ascii_letters / len(letters) > 0.85


def parse_lrc(lrc: str, total_duration: float) -> list[SubtitleEntry]:
    """把 LRC 同步歌詞解析成句子列表；每行結束時間 = 下一行開始時間。"""
    rows = []
    for line in lrc.split("\n"):
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)", line.strip())
        if not m:
            continue
        start = int(m.group(1)) * 60 + float(m.group(2))
        text = m.group(3).strip()
        if text:
            rows.append((start, text))
    rows.sort(key=lambda r: r[0])
    entries = []
    for i, (start, text) in enumerate(rows):
        end = rows[i + 1][0] if i + 1 < len(rows) else min(start + 6.0, max(total_duration, start + 2.0))
        entries.append(SubtitleEntry(start, end, text))
    return entries


def _first_lrc_time(lrc: str) -> float | None:
    """取出 LRC 歌詞中第一句非空白歌詞的時間（秒）。"""
    for line in lrc.split("\n"):
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)", line.strip())
        if m and m.group(3).strip():
            return int(m.group(1)) * 60 + float(m.group(2))
    return None


def _pick_best_candidate(candidates: list[dict], total_duration: float,
                         vocal_onset: float | None = None) -> dict | None:
    """從候選歌詞中挑最可能對齊這個音訊的版本。
    lrclib 是社群上傳的資料庫：即使時長相同的候選，第一句的起點也可能差好幾秒
    （實測 Shape of You 同為 263s 的候選，第一句從 9.86s 到 15.82s 都有）。
    因此先用時長過濾（±20s 排除 remix/live），再用「實測人聲起點」挑第一句
    時間最接近的版本；沒有人聲起點資訊時退回挑時長最接近的。"""
    if not candidates:
        return None
    if total_duration > 0:
        candidates = [r for r in candidates
                      if abs((r.get("duration") or 0) - total_duration) <= 20]
        if not candidates:
            return None
    if vocal_onset is not None:
        def onset_distance(r):
            t = _first_lrc_time(r.get("syncedLyrics") or "")
            return abs(t - vocal_onset) if t is not None else 9999.0
        return min(candidates, key=onset_distance)
    if total_duration > 0:
        return min(candidates, key=lambda r: abs((r.get("duration") or 0) - total_duration))
    return candidates[0]


# 人聲起點偵測：探測前 45 秒（涵蓋多數官方 MV 的開場動畫），用 Silero VAD 模型
VOCAL_ONSET_PROBE_SECONDS = 45.0
VAD_BIN = os.getenv("VAD_BIN", "whisper-vad-speech-segments")
VAD_MODEL = os.getenv("VAD_MODEL", str(BASE_DIR / "models" / "ggml-silero-v5.1.2.bin"))


def detect_vocal_onset(audio_path: Path, video_id: str) -> float | None:
    """用 VAD（語音活動偵測）找出音訊開頭第一段人聲的起點（秒）。
    官方 MV 常有前奏動畫，音訊和歌詞資料庫的版本不一定對齊，需要實測校正。
    （曾嘗試用 whisper 轉錄時間戳推算，但 whisper 會把前奏和第一句糊成一段、
    起點錨在 0 秒，不可靠；VAD 是專門偵測「有沒有人聲」的模型，準確得多。）
    模型檔或工具不存在時回 None（優雅降級，不擋流程）。"""
    if not Path(VAD_MODEL).exists():
        return None
    probe_wav = AUDIO_CACHE / f"{video_id}_onset_probe.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(audio_path), "-t", str(VOCAL_ONSET_PROBE_SECONDS),
         "-ar", "16000", "-ac", "1", str(probe_wav)],
        capture_output=True, text=True,
    )
    try:
        result = subprocess.run(
            [VAD_BIN, "-f", str(probe_wav), "-vm", VAD_MODEL, "-np"],
            capture_output=True, text=True,
        )
    except FileNotFoundError:
        return None
    finally:
        probe_wav.unlink(missing_ok=True)
    # 輸出格式：「Speech segment 0: start = 1408.00, end = 1443.00」，單位是 centisecond（10ms）
    # （已實測驗證：1408 → 14.08 秒處剪下去正好是第一句歌詞）
    for line in result.stdout.split("\n"):
        m = re.search(r"Speech segment 0: start = ([\d.]+)", line)
        if m:
            return float(m.group(1)) / 100.0
    return None


# 注意：曾實作「用 VAD 起點自動平移歌詞時間軸」，實測發現 VAD 可能把前奏的
# 和聲/墊音判為人聲（Styx - Babe 的 37.8s 正確起點被平移到 0.3s，災難性回歸），
# 平移的風險大於收益，已移除。VAD 起點只用於「挑候選版本」（安全：不改時間軸，
# 只做選擇），殘餘的小偏差交給前端的「歌詞對齊」手動微調鈕。


LRCLIB_GET_API = "https://lrclib.net/api/get"


async def fetch_lyrics(title: str, channel: str, total_duration: float,
                       video_id: str, audio_path: Path,
                       track: str = "", artist: str = "") -> list[SubtitleEntry]:
    """用 lrclib 找同步英文歌詞。優先用 yt-dlp 給的精確 track/artist（如 YouTube Music）
    做精準比對；沒有精確欄位或找不到時，才退回模糊標題搜尋。找不到就明確報錯
    （不 fallback 到 whisper 亂猜歌詞——唱歌對 whisper 是硬傷）。"""
    cache_path = AUDIO_CACHE / f"{video_id}_lyrics.json"
    if cache_path.exists():
        return [SubtitleEntry(**e) for e in json.loads(cache_path.read_text())]

    # 先實測這個音訊檔案的人聲起點，供「挑候選版本」與「時間軸校正」使用
    vocal_onset = detect_vocal_onset(audio_path, video_id)

    best = None
    query_desc = clean_music_title(title)

    # 第一優先：精確的 artist + track（YouTube Music 通常提供，準確度遠高於模糊標題）
    if track and artist:
        query_desc = f"{artist} - {track}"
        async with httpx.AsyncClient(timeout=30.0) as http:
            resp = await http.get(LRCLIB_GET_API, params={
                "track_name": track, "artist_name": artist,
            })
        if resp.status_code == 200:
            data = resp.json()
            if data.get("syncedLyrics"):
                best = data

    # 精確查詢沒中 → 退回模糊標題搜尋
    if best is None:
        query = clean_music_title(title)
        async with httpx.AsyncClient(timeout=30.0) as http:
            resp = await http.get(LRCLIB_API, params={"q": query})
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="歌詞服務暫時無法使用，請稍後再試。")
        candidates = [r for r in resp.json() if r.get("syncedLyrics")]
        best = _pick_best_candidate(candidates, total_duration, vocal_onset)
        if best is None and candidates:
            raise HTTPException(
                status_code=404,
                detail=f"找到「{query}」的歌詞，但時間軸與這個音訊版本對不上（可能是 remix/live 版），無法使用。")
        query_desc = query

    if best is None:
        raise HTTPException(
            status_code=404,
            detail=f"找不到「{query_desc}」的同步歌詞，這首歌暫時無法製作教材。")

    if not is_english_lyrics(best["syncedLyrics"]):
        raise HTTPException(status_code=404, detail="這首歌的歌詞不是英文，目前只支援英文歌曲。")

    entries = parse_lrc(best["syncedLyrics"], total_duration)
    if len(entries) < 4:
        raise HTTPException(status_code=404, detail="同步歌詞行數太少，無法製作教材。")

    cache_path.write_text(json.dumps([e.to_dict() for e in entries]))
    return entries


# 單句字元上限：whisper 對長影片偶爾會有一大段沒有句末標點，
# 若不強制斷句會產生「怪獸句」，翻譯時可能要極久甚至逾時。
MAX_SENTENCE_CHARS = 220


def split_into_sentences(entries: list[SubtitleEntry]) -> list[SubtitleEntry]:
    """把 whisper 片段重組成完整句子。片段內部的句末標點 (. ! ?) 也會斷句，
    斷句時間在該片段內按字數比例估算，確保每句都是完整句子且時間戳合理。
    若長時間沒有句末標點，會在達到字元上限時強制斷句，避免產生怪獸句。"""
    if not entries:
        return []
    sentences: list[SubtitleEntry] = []
    cur: list[str] = []
    cur_start = None
    for e in entries:
        text = e.text.strip()
        if not text:
            continue
        if cur_start is None:
            cur_start = e.start
        parts = re.split(r'(?<=[.!?])\s+', text)
        dur = max(e.end - e.start, 0.001)
        total = max(len(text), 1)
        consumed = 0
        for part in parts:
            cur.append(part)
            consumed += len(part) + 1
            part_time = e.start + dur * min(consumed / total, 1.0)
            cur_len = sum(len(p) + 1 for p in cur)
            ends_sentence = re.search(r'[.!?]["\'\)\]]?$', part.strip())
            # 句末標點 → 正常斷句；或累積過長 → 強制斷句（防怪獸句）
            if ends_sentence or cur_len >= MAX_SENTENCE_CHARS:
                sentences.append(SubtitleEntry(cur_start, part_time, " ".join(cur).strip()))
                cur, cur_start = [], part_time
    if cur:
        sentences.append(SubtitleEntry(cur_start, entries[-1].end, " ".join(cur).strip()))
    return sentences


def split_into_segments(entries: list[SubtitleEntry],
                        segment_duration: float = SEGMENT_DURATION) -> list[list[SubtitleEntry]]:
    if not entries:
        return []
    segments = []
    current = []
    segment_start = entries[0].start

    for entry in entries:
        current.append(entry)
        elapsed = entry.end - segment_start
        if elapsed >= segment_duration and len(current) >= 3:
            segments.append(current)
            current = []
            segment_start = entry.end

    if current:
        if segments and len(current) < 3:
            segments[-1].extend(current)
        else:
            segments.append(current)

    return segments


def split_audio_segment(audio_path: Path, video_id: str, seg_idx: int, start: float, end: float) -> Path:
    seg_path = AUDIO_CACHE / f"{video_id}_seg{seg_idx}.mp3"
    if seg_path.exists():
        return seg_path
    cmd = [
        "ffmpeg", "-y",
        "-i", str(audio_path),
        "-ss", str(start),
        "-to", str(end),
        "-c", "copy",
        seg_path,
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    return seg_path


TRANSLATE_CONCURRENCY = 4
_translate_sem = asyncio.Semaphore(TRANSLATE_CONCURRENCY)


async def translate_one(http: httpx.AsyncClient, text: str) -> str:
    """逐句翻譯，確保中英文一對一對齊。
    任何單句失敗（逾時、Ollama 錯誤等）都只回傳空字串，不拖垮整個任務。"""
    prompt = f"把這句英文翻譯成繁體中文，只輸出翻譯本身，不要任何說明或原文：\n\n{text}"
    try:
        async with _translate_sem:
            resp = await http.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": OLLAMA_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1},
                },
            )
        if resp.status_code != 200:
            print(f"[translate] Ollama 非 200：{resp.status_code} {resp.text[:200]}")
            return ""
        out = resp.json().get("response", "")
        # 移除可能的 <think> 推理區塊，取第一行非空白內容
        out = re.sub(r"<think>.*?</think>", "", out, flags=re.DOTALL).strip()
        for line in out.split("\n"):
            line = line.strip()
            if line:
                return line
        return ""
    except Exception as e:
        print(f"[translate] 單句翻譯失敗（略過）：{type(e).__name__}: {e}")
        return ""


def load_trans_cache(video_id: str) -> dict:
    p = AUDIO_CACHE / f"{video_id}_trans.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save_trans_cache(video_id: str, cache: dict) -> None:
    (AUDIO_CACHE / f"{video_id}_trans.json").write_text(
        json.dumps(cache, ensure_ascii=False))


async def translate_texts(texts: list[str], cache: dict) -> list[str]:
    """逐句翻譯，並用 cache（英文→中文）避免重翻。只翻譯快取中沒有的句子。
    單句逾時上限 180 秒，真的卡住就跳過，不讓單句拖垮整批。"""
    todo = [t for t in dict.fromkeys(texts) if t not in cache]  # 去重後仍缺的
    if todo:
        async with httpx.AsyncClient(timeout=180.0) as http:
            results = await asyncio.gather(*(translate_one(http, t) for t in todo))
        for t, r in zip(todo, results):
            if r:  # 只快取成功（非空）的翻譯；失敗的不存，下次會重試
                cache[t] = r
    return [cache.get(t, "") for t in texts]


# 並行保險：全域同時只允許處理一支影片，避免同時開多支互相拖垮資源。
# （事件迴圈單執行緒，下方「檢查→加入」之間沒有 await，是原子操作，無 race。）
_processing_ids: set[str] = set()


@app.post("/api/process")
async def process_video(req: VideoRequest):
    video_id = get_video_id(req.url)

    full_result = AUDIO_CACHE / f"{video_id}_result.json"           # 完整結果
    partial_result = AUDIO_CACHE / f"{video_id}_result_partial.json"  # 前 6 分鐘結果

    # 完整結果一律優先回傳（是部分結果的超集）
    if full_result.exists():
        return json.loads(full_result.read_text())
    # 非「全部下載」且已有部分結果 → 回傳部分
    if not req.full and partial_result.exists():
        return json.loads(partial_result.read_text())

    # 需要實際處理 → 套用並行保險
    if _processing_ids:
        raise HTTPException(
            status_code=409,
            detail="目前有另一支影片正在處理中，請等它完成後再試。",
        )
    _processing_ids.add(video_id)
    try:
        audio_path = download_audio(req.url, video_id)
        total_duration = get_media_duration(audio_path)
        info = get_video_info(req.url, video_id)
        title = info["title"]
        # 音樂模式：歌曲短，一律整首處理（無「前 6 分鐘」概念）
        is_full = req.full or req.music
        limit = None if is_full else PREVIEW_SECONDS

        # 全部下載：清掉部分結果與舊切段，重新乾淨產生（翻譯快取保留，不重翻）
        if is_full:
            partial_result.unlink(missing_ok=True)
            (AUDIO_CACHE / f"{video_id}_subs_partial.json").unlink(missing_ok=True)
            for f in AUDIO_CACHE.glob(f"{video_id}_seg*.mp3"):
                f.unlink(missing_ok=True)

        if req.music:
            entries = await fetch_lyrics(title, info["channel"], total_duration, video_id, audio_path,
                                          info.get("track", ""), info.get("artist", ""))
        else:
            entries = transcribe_audio(audio_path, video_id, limit)
        segments = split_into_segments(
            entries, MUSIC_SEGMENT_DURATION if req.music else SEGMENT_DURATION)

        trans_cache = load_trans_cache(video_id)
        result_segments = []
        for i, seg_entries in enumerate(segments):
            start = seg_entries[0].start
            end = seg_entries[-1].end
            split_audio_segment(audio_path, video_id, i, start, end)

            en_texts = [e.text for e in seg_entries]
            zh_texts = await translate_texts(en_texts, trans_cache)
            save_trans_cache(video_id, trans_cache)  # 逐段存，中斷也不白費

            sentences = []
            for j, entry in enumerate(seg_entries):
                sentences.append({
                    "index": j,
                    "start": entry.start - start,
                    "end": entry.end - start,
                    "en": entry.text,
                    "zh": zh_texts[j] if j < len(zh_texts) else "",
                })

            result_segments.append({
                "segment_index": i,
                "audio_url": f"/api/audio/{video_id}/{i}",
                "sentences": sentences,
                "duration": end - start,
            })

        result = {
            "video_id": video_id,
            "title": title,
            "channel": info["channel"],
            "channel_url": info["channel_url"],
            "segments": result_segments,
            "partial": not is_full,
            "music": req.music,
            "total_duration": total_duration,
            "preview_seconds": PREVIEW_SECONDS,
        }
        target = full_result if is_full else partial_result
        target.write_text(json.dumps(result, ensure_ascii=False))
        save_meta(video_id, req.url, title, total_duration, not is_full,
                  info["channel"], info["channel_url"], req.music,
                  info.get("track", ""), info.get("artist", ""))
        return result
    finally:
        _processing_ids.discard(video_id)


@app.get("/api/channel_info")
async def channel_info(url: str):
    """把使用者貼上的頻道（或影片）網址解析成頻道名稱，供「喜歡的頻道」用文字顯示。"""
    r = subprocess.run(
        ["yt-dlp", *yt_dlp_auth_args(), "--flat-playlist", "--playlist-items", "1",
         "--print", "%(channel,uploader,playlist_title,uploader_id)s",
         "--print", "%(channel_url,uploader_url)s", url],
        capture_output=True, text=True,
    )
    lines = r.stdout.strip().split("\n")
    name = _clean_field(lines[0]) if len(lines) > 0 else ""
    channel_url = _clean_field(lines[1]) if len(lines) > 1 else ""
    return {"name": name, "url": channel_url or url}


@app.get("/api/library")
async def get_library():
    """列出所有已處理過的影片（供前端側欄快速存取）。"""
    items = []
    for meta_file in AUDIO_CACHE.glob("*_meta.json"):
        try:
            items.append(json.loads(meta_file.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    items.sort(key=lambda m: m.get("updated_at", 0), reverse=True)
    return {"videos": items}


@app.delete("/api/library/{video_id}")
async def delete_library_item(video_id: str):
    """真刪除：移除該影片的所有快取檔（音訊、轉錄、翻譯、切段、meta），釋放空間。"""
    if not re.fullmatch(r"[0-9a-f]{12}", video_id):
        raise HTTPException(status_code=400, detail="無效的影片 ID")
    if video_id in _processing_ids:
        raise HTTPException(status_code=409, detail="此影片正在處理中，無法刪除。")
    removed = 0
    # video_id 已驗證為 12 位 hex，glob 前綴安全
    for f in AUDIO_CACHE.glob(f"{video_id}*"):
        try:
            f.unlink()
            removed += 1
        except OSError:
            pass
    return {"deleted": video_id, "files_removed": removed}


@app.get("/api/audio/{video_id}/{seg_idx}")
async def get_audio(video_id: str, seg_idx: int):
    path = AUDIO_CACHE / f"{video_id}_seg{seg_idx}.mp3"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Audio segment not found")
    return FileResponse(path, media_type="audio/mpeg")


app.mount("/", StaticFiles(directory=str(BASE_DIR / "frontend"), html=True), name="frontend")
