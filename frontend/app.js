let appData = null;
let currentSegment = 0;
let currentSentence = 0;
let currentMode = "playback";
let audio = null;
let showEn = true;
let showZh = false;
let isPlaying = false;
let dictationTimer = null;
let dictationCountdown = 10;
let dictationInterval = null;
let sentenceEndHandler = null;
let playbackSpeed = parseFloat(localStorage.getItem("ps_speed") || "1");
let pendingJump = null;  // 從最愛跳轉時暫存 {segIdx, sentIdx}
let loadedUrl = null;    // 目前已載入結果的網址（用來決定「開始處理」是否變灰）
let inputMode = "video"; // "video" | "music" — 目前輸入模式
let lyricsOffset = 0;    // 歌詞時間軸偏移（秒），每首歌各自記在 localStorage

// ---- 歌詞對齊手動微調（音樂模式）----
function loadLyricsOffset() {
    if (!appData) return 0;
    try {
        const m = JSON.parse(localStorage.getItem("ps_lyric_offsets") || "{}");
        return m[appData.video_id] || 0;
    } catch { return 0; }
}

function saveLyricsOffset() {
    if (!appData) return;
    try {
        const m = JSON.parse(localStorage.getItem("ps_lyric_offsets") || "{}");
        m[appData.video_id] = lyricsOffset;
        localStorage.setItem("ps_lyric_offsets", JSON.stringify(m));
    } catch { /* 存不進去就算了，不影響播放 */ }
}

function adjustLyricsOffset(delta) {
    lyricsOffset = Math.round((lyricsOffset + delta) * 10) / 10;
    saveLyricsOffset();
    const disp = document.getElementById("offset-display");
    if (disp) disp.textContent = `${lyricsOffset.toFixed(1)}s`;
    replaySentence();  // 立即用新偏移重播目前句，聽得出差異
}

function setInputMode(mode) {
    inputMode = mode;
    document.querySelectorAll(".input-mode-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.mode === mode);
    });
    const input = document.getElementById("youtube-url");
    if (input) {
        input.placeholder = mode === "music"
            ? "貼上 YouTube / YouTube Music 英文歌曲連結..."
            : "貼上 YouTube 連結...";
    }
    loadedUrl = null;  // 換模式 → 重新啟用「開始處理」
    updateProcessBtnState();
    // 切換影片/音樂模式時，側欄也一併切到對應分類，維持一致的心智模型
    setLibraryScope(mode);
    setFavScope(mode);
    setChannelScope(mode);
}

// 已載入該網址 → 「開始處理」變灰；改了網址才重新啟用
function updateProcessBtnState() {
    const btn = document.getElementById("process-btn");
    if (!btn) return;
    const url = document.getElementById("youtube-url").value.trim();
    btn.disabled = !!loadedUrl && url === loadedUrl;
}

// ---- 最愛（localStorage）----
function loadFavorites() {
    try { return JSON.parse(localStorage.getItem("ps_favorites") || "[]"); }
    catch { return []; }
}
function saveFavorites(favs) {
    localStorage.setItem("ps_favorites", JSON.stringify(favs));
}
function favKey(videoId, segIdx, sentIdx) {
    return `${videoId}:${segIdx}:${sentIdx}`;
}
function isFavorited(segIdx, sentIdx) {
    if (!appData) return false;
    const key = favKey(appData.video_id, segIdx, sentIdx);
    return loadFavorites().some(f => f.key === key);
}

async function processVideo(full = false) {
    const url = document.getElementById("youtube-url").value.trim();
    if (!url) return;

    const music = inputMode === "music";
    const btn = document.getElementById("process-btn");
    btn.disabled = true;
    const loading = document.getElementById("loading");
    loading.querySelector("p").textContent = music
        ? "正在下載歌曲、抓取同步歌詞、翻譯中，請稍候..."
        : (full
            ? "正在下載並處理整支影片，請稍候..."
            : "正在處理前 6 分鐘（下載、轉錄、翻譯），請稍候...");
    loading.classList.remove("hidden");
    document.getElementById("error-msg").classList.add("hidden");
    if (!full) document.getElementById("segments-section").classList.add("hidden");

    try {
        const resp = await fetch("/api/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, full, music }),
        });
        if (!resp.ok) {
            // 錯誤回應可能是 JSON ({detail:...}) 或純文字 ("Internal Server Error")，
            // 都要能優雅顯示，不可直接 JSON.parse 失敗。
            const raw = await resp.text();
            let msg;
            try {
                msg = JSON.parse(raw).detail || raw;
            } catch {
                msg = raw || `處理失敗 (HTTP ${resp.status})`;
            }
            throw new Error(msg);
        }
        appData = await resp.json();
        loadedUrl = url;  // 記住已載入的網址
        lyricsOffset = loadLyricsOffset();  // 讀回這首歌已存的歌詞對齊偏移
        currentSegment = 0;
        currentSentence = 0;
        renderCurrentChannelBar();
        renderPartialBanner();
        renderSegmentTabs();
        loadSegment(0);
        document.getElementById("segments-section").classList.remove("hidden");
        loadLibrary();  // 重新整理側欄並高亮目前影片
        if (pendingJump) {  // 從最愛跳轉
            const { segIdx, sentIdx } = pendingJump;
            pendingJump = null;
            gotoSentence(segIdx, sentIdx);
        }
    } catch (e) {
        const errDiv = document.getElementById("error-msg");
        errDiv.textContent = e.message;
        errDiv.classList.remove("hidden");
    } finally {
        btn.disabled = false;
        loading.classList.add("hidden");
        updateProcessBtnState();  // 若已載入此網址則維持變灰
    }
}

function renderPartialBanner() {
    const banner = document.getElementById("partial-banner");
    const total = appData.total_duration || 0;
    const preview = appData.preview_seconds || 360;
    // 只有「部分處理」且影片確實比預覽長，才顯示「全部下載」
    if (appData.partial && total > preview + 5) {
        const totalMin = Math.round(total / 60);
        const previewMin = Math.round(preview / 60);
        banner.innerHTML = `
            <span>目前只處理了前 ${previewMin} 分鐘（整支約 ${totalMin} 分鐘）。</span>
            <button id="download-all-btn" onclick="processVideo(true)">⬇ 全部下載</button>
        `;
        banner.classList.remove("hidden");
    } else {
        banner.classList.add("hidden");
    }
}

let libVideos = [];  // 最近一次抓到的影片庫資料

function getLibOrder() {
    try { return JSON.parse(localStorage.getItem("ps_lib_order") || "[]"); }
    catch { return []; }
}
function saveLibOrder(arr) {
    localStorage.setItem("ps_lib_order", JSON.stringify(arr));
}

let libraryScope = "video";  // "video" | "music" — 目前顯示影片庫還是音樂盒

function setLibraryScope(scope) {
    libraryScope = scope;
    document.querySelectorAll('#sidebar .mini-tabs')[0].querySelectorAll(".mini-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.scope === scope);
    });
    renderLibrary();
}

async function loadLibrary() {
    try {
        const resp = await fetch("/api/library");
        if (!resp.ok) return;
        const data = await resp.json();
        libVideos = data.videos || [];
        renderLibrary();
    } catch {
        /* 側欄載入失敗不影響主功能 */
    }
}

// 依使用者自訂順序排列（新影片排在最後），並回存正規化後的順序
function orderedLibVideos() {
    const byId = Object.fromEntries(libVideos.map(v => [v.video_id, v]));
    let order = getLibOrder().filter(id => byId[id]);
    for (const v of libVideos) if (!order.includes(v.video_id)) order.push(v.video_id);
    saveLibOrder(order);
    return order.map(id => byId[id]);
}

function scopedLibVideos() {
    const wantMusic = libraryScope === "music";
    return orderedLibVideos().filter(v => !!v.music === wantMusic);
}

function renderLibrary() {
    const list = document.getElementById("sidebar-list");
    const videos = scopedLibVideos();
    if (!videos.length) {
        list.innerHTML = libraryScope === "music"
            ? `<p class="sidebar-empty">尚無已處理歌曲</p>`
            : `<p class="sidebar-empty">尚無已處理影片</p>`;
        return;
    }
    const activeId = appData ? appData.video_id : null;
    list.innerHTML = videos.map((v, i) => {
        const mins = Math.round((v.total_duration || 0) / 60);
        const badge = (!v.music && v.partial) ? `<span class="lib-badge">前 6 分鐘</span>` : "";
        const active = v.video_id === activeId ? " active" : "";
        const safeTitle = (v.title || "未命名影片").replace(/</g, "&lt;");
        const safeUrl = (v.url || "").replace(/"/g, "&quot;");
        return `
            <div class="lib-item${active}">
                <div class="lib-item-main" onclick="openFromLibrary('${safeUrl}', ${v.music ? "true" : "false"})">
                    <div class="lib-item-title">${safeTitle}</div>
                    <div class="lib-item-meta">${badge}<span>${mins} 分鐘</span></div>
                </div>
                <div class="item-actions">
                    <button class="item-btn" title="上移" onclick="event.stopPropagation();moveLibItem(${i},-1)">▲</button>
                    <button class="item-btn" title="下移" onclick="event.stopPropagation();moveLibItem(${i},1)">▼</button>
                    <button class="item-btn item-del" title="刪除" onclick="event.stopPropagation();deleteLibItem('${v.video_id}')">✕</button>
                </div>
            </div>`;
    }).join("");
}

// 排序只在目前分頁（影片庫/音樂盒）的範圍內移動，不影響另一邊的順序
function moveLibItem(i, dir) {
    const j = i + dir;
    const scoped = scopedLibVideos();
    if (j < 0 || j >= scoped.length) return;
    const order = getLibOrder();
    const posA = order.indexOf(scoped[i].video_id);
    const posB = order.indexOf(scoped[j].video_id);
    [order[posA], order[posB]] = [order[posB], order[posA]];
    saveLibOrder(order);
    renderLibrary();
}

async function deleteLibItem(videoId) {
    if (!confirm("確定刪除這支影片的所有快取？（之後可重新處理）")) return;
    try {
        const resp = await fetch(`/api/library/${videoId}`, { method: "DELETE" });
        if (!resp.ok) {
            const raw = await resp.text();
            let msg; try { msg = JSON.parse(raw).detail || raw; } catch { msg = raw; }
            alert("刪除失敗：" + msg);
            return;
        }
    } catch {
        alert("刪除失敗：無法連線");
        return;
    }
    saveLibOrder(getLibOrder().filter(id => id !== videoId));
    loadLibrary();
}

function openFromLibrary(url, music = false) {
    if (!url) return;
    setInputMode(music ? "music" : "video");  // 依項目類型切換模式
    document.getElementById("youtube-url").value = url;
    processVideo(false);  // 已快取者會直接秒回
}

// ---- 喜歡的頻道（localStorage）----
// 用安全的 DOM 方法（textContent）建構，避免 innerHTML 的 XSS 風險
let channelScope = "video";  // "video" | "music" — 目前顯示影片頻道還是音樂頻道

function setChannelScope(scope) {
    channelScope = scope;
    document.querySelectorAll("#channels .mini-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.scope === scope);
    });
    renderChannels();
}

function loadChannels() {
    try { return JSON.parse(localStorage.getItem("ps_channels") || "[]"); }
    catch { return []; }
}
function saveChannels(c) { localStorage.setItem("ps_channels", JSON.stringify(c)); }
function channelExists(url) {
    const wantMusic = inputMode === "music";
    return loadChannels().some(c => c.url === url && !!c.music === wantMusic);
}
function scopedChannels() {
    const wantMusic = channelScope === "music";
    return loadChannels().filter(c => !!c.music === wantMusic);
}

function renderChannels() {
    const list = document.getElementById("channel-list");
    if (!list) return;
    const chans = scopedChannels();
    list.replaceChildren();
    if (!chans.length) {
        const p = document.createElement("p");
        p.className = "sidebar-empty";
        p.textContent = channelScope === "music" ? "尚無收藏音樂頻道" : "尚無收藏頻道";
        list.appendChild(p);
        return;
    }
    chans.forEach((c, i) => {
        const item = document.createElement("div");
        item.className = "channel-item";

        const nameEl = document.createElement("span");
        nameEl.className = "channel-name";
        nameEl.title = "在 YouTube 開啟";
        nameEl.textContent = c.name || c.url || "未命名頻道";
        nameEl.addEventListener("click", () => openChannel(c.url));

        const del = document.createElement("button");
        del.className = "item-btn item-del";
        del.title = "移除";
        del.textContent = "✕";
        del.addEventListener("click", () => deleteChannel(i));

        item.appendChild(nameEl);
        item.appendChild(del);
        list.appendChild(item);
    });
}

function openChannel(url) {
    if (url) window.open(url, "_blank", "noopener");
}

function addChannel(name, url, music = false) {
    const chans = loadChannels();
    if (chans.some(c => c.url === url && !!c.music === music)) return;  // 去重（同分類內）
    chans.unshift({ name: name || url, url, music });
    saveChannels(chans);
    renderChannels();
    renderCurrentChannelBar();
}

function deleteChannel(i) {
    // 同上：loadChannels() 每次重新 JSON.parse，物件參考不同，用 url+music 比對。
    const scoped = scopedChannels();
    const target = scoped[i];
    if (!target) return;
    const chans = loadChannels();
    const pos = chans.findIndex(c => c.url === target.url && !!c.music === !!target.music);
    if (pos >= 0) chans.splice(pos, 1);
    saveChannels(chans);
    renderChannels();
    renderCurrentChannelBar();
}

async function addChannelByUrl() {
    const input = document.getElementById("channel-url");
    const url = input.value.trim();
    if (!url) return;
    const music = channelScope === "music";
    const btn = document.getElementById("add-channel-btn");
    btn.disabled = true;
    btn.textContent = "…";
    try {
        const resp = await fetch("/api/channel_info?url=" + encodeURIComponent(url));
        let info = { name: "", url };
        if (resp.ok) info = await resp.json();
        addChannel(info.name || url, info.url || url, music);
        input.value = "";
    } catch {
        addChannel(url, url, music);  // 解析失敗也先存起來（用網址當名稱）
        input.value = "";
    } finally {
        btn.disabled = false;
        btn.textContent = "加入";
    }
}

// 收藏「目前影片」的頻道
function addCurrentChannel() {
    if (!appData || !appData.channel_url) return;
    addChannel(appData.channel || appData.channel_url, appData.channel_url, !!appData.music);
}

// 輸入框旁的 ★：解析目前貼上的影片網址所屬頻道，加入「喜歡的頻道」
async function addChannelFromInput() {
    const url = document.getElementById("youtube-url").value.trim();
    if (!url) { alert("請先在上方貼上 YouTube 影片連結"); return; }
    const star = document.getElementById("fav-channel-star");
    star.disabled = true;
    const original = star.textContent;
    star.textContent = "…";
    try {
        const resp = await fetch("/api/channel_info?url=" + encodeURIComponent(url));
        let info = { name: "", url };
        if (resp.ok) info = await resp.json();
        if (!info.name && !info.url) throw new Error("無法解析頻道");
        addChannel(info.name || info.url, info.url || url, inputMode === "music");
        star.classList.add("on");  // 視覺回饋：已收藏
    } catch {
        alert("解析頻道失敗，請確認這是有效的 YouTube 影片連結");
    } finally {
        star.disabled = false;
        star.textContent = original;
    }
}

function renderCurrentChannelBar() {
    const bar = document.getElementById("current-channel-bar");
    if (!bar) return;
    bar.replaceChildren();
    if (!appData || !appData.channel_url || !appData.channel) {
        bar.classList.add("hidden");
        return;
    }
    const saved = channelExists(appData.channel_url);
    const btn = document.createElement("button");
    btn.className = "save-channel-btn" + (saved ? " saved" : "");
    btn.textContent = saved
        ? `✓ 已收藏頻道：${appData.channel}`
        : `＋ 收藏頻道：${appData.channel}`;
    if (!saved) btn.addEventListener("click", addCurrentChannel);
    bar.appendChild(btn);
    bar.classList.remove("hidden");
}

// ---- 播放速度 ----
function setSpeed(s) {
    playbackSpeed = s;
    localStorage.setItem("ps_speed", String(s));
    if (audio) audio.playbackRate = s;
    document.querySelectorAll(".speed-btn").forEach(b => {
        b.classList.toggle("on", b.textContent === `${s}x`);
    });
}

// ---- 最愛收藏 ----
let favScope = "video";  // "video" | "music" — 目前顯示我的最愛還是我的歌詞

function setFavScope(scope) {
    favScope = scope;
    document.querySelectorAll('#sidebar .mini-tabs')[1].querySelectorAll(".mini-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.scope === scope);
    });
    renderFavorites();
}

function scopedFavorites() {
    const wantMusic = favScope === "music";
    return loadFavorites().filter(f => !!f.music === wantMusic);
}

function toggleFavorite() {
    if (!appData) return;
    const seg = appData.segments[currentSegment];
    const s = seg.sentences[currentSentence];
    const key = favKey(appData.video_id, currentSegment, currentSentence);
    let favs = loadFavorites();
    const idx = favs.findIndex(f => f.key === key);
    if (idx >= 0) {
        favs.splice(idx, 1);
    } else {
        favs.unshift({
            key,
            videoId: appData.video_id,
            url: document.getElementById("youtube-url").value.trim(),
            title: appData.title || "未命名影片",
            music: !!appData.music,
            segIdx: currentSegment,
            sentIdx: currentSentence,
            en: s.en,
            zh: s.zh,
        });
    }
    saveFavorites(favs);
    const btn = document.getElementById("star-btn");
    if (btn) btn.classList.toggle("on", idx < 0);
    renderFavorites();
}

function renderFavorites() {
    const favs = scopedFavorites();
    const header = document.getElementById("fav-header");
    const list = document.getElementById("fav-list");
    if (header) header.textContent = favScope === "music" ? `🎤 我的歌詞 (${favs.length})` : `⭐ 我的最愛 (${favs.length})`;
    if (!list) return;
    if (!favs.length) {
        list.innerHTML = favScope === "music"
            ? `<p class="sidebar-empty">在歌詞旁點 ★ 收藏</p>`
            : `<p class="sidebar-empty">點句子旁的 ★ 收藏</p>`;
        return;
    }
    list.innerHTML = favs.map((f, i) => {
        const en = (f.en || "").replace(/</g, "&lt;");
        const zh = (f.zh || "").replace(/</g, "&lt;");
        return `
            <div class="fav-item">
                <div class="fav-text" onclick="jumpToFavorite(${i})">
                    <div class="fav-en">${en}</div>
                    <div class="fav-zh">${zh}</div>
                </div>
                <div class="item-actions">
                    <button class="item-btn" title="上移" onclick="event.stopPropagation();moveFav(${i},-1)">▲</button>
                    <button class="item-btn" title="下移" onclick="event.stopPropagation();moveFav(${i},1)">▼</button>
                    <button class="item-btn item-del" title="移除" onclick="event.stopPropagation();deleteFavorite(${i})">✕</button>
                </div>
            </div>`;
    }).join("");
}

// 排序/刪除只在目前分頁（最愛/歌詞）範圍內操作，透過絕對位置對應回完整陣列
// 注意：loadFavorites() 每次都重新 JSON.parse，物件參考不同，
// 所以這裡一律用 f.key 比對，不能用 indexOf(物件參考)。
function moveFav(i, dir) {
    const j = i + dir;
    const scoped = scopedFavorites();
    if (j < 0 || j >= scoped.length) return;
    const favs = loadFavorites();
    const posA = favs.findIndex(f => f.key === scoped[i].key);
    const posB = favs.findIndex(f => f.key === scoped[j].key);
    [favs[posA], favs[posB]] = [favs[posB], favs[posA]];
    saveFavorites(favs);
    renderFavorites();
}

function deleteFavorite(i) {
    const scoped = scopedFavorites();
    const target = scoped[i];
    if (!target) return;
    const favs = loadFavorites();
    const pos = favs.findIndex(f => f.key === target.key);
    if (pos >= 0) favs.splice(pos, 1);
    saveFavorites(favs);
    renderFavorites();
    // 若刪的是目前這句，更新星號
    const btn = document.getElementById("star-btn");
    if (btn) btn.classList.toggle("on", isFavorited(currentSegment, currentSentence));
}

async function jumpToFavorite(i) {
    const scoped = scopedFavorites();
    const f = scoped[i];
    if (!f) return;
    // 已是目前影片 → 直接跳；否則切到對應模式（影片/音樂）再載入該項目
    if (appData && appData.video_id === f.videoId) {
        gotoSentence(f.segIdx, f.sentIdx);
    } else {
        setInputMode(f.music ? "music" : "video");
        pendingJump = { segIdx: f.segIdx, sentIdx: f.sentIdx };
        document.getElementById("youtube-url").value = f.url || "";
        await processVideo(false);
    }
}

function gotoSentence(segIdx, sentIdx) {
    if (!appData || !appData.segments[segIdx]) return;
    loadSegment(segIdx);
    document.querySelectorAll(".seg-tab").forEach((t, i) => t.classList.toggle("active", i === segIdx));
    currentSentence = Math.min(sentIdx, appData.segments[segIdx].sentences.length - 1);
    updateDisplay();
    const star = document.getElementById("star-btn");
    if (star) star.classList.toggle("on", isFavorited(segIdx, currentSentence));
    playSentence();
}

// ---- 亮/暗主題 ----
function applyTheme(theme) {
    document.body.classList.toggle("light-theme", theme === "light");
    const btn = document.getElementById("theme-toggle");
    // 顯示目前模式；點下去即切換
    if (btn) btn.textContent = theme === "light" ? "☀️ 亮色模式" : "🌙 暗色模式";
    localStorage.setItem("ps_theme", theme);
}
function toggleTheme() {
    const next = document.body.classList.contains("light-theme") ? "dark" : "light";
    applyTheme(next);
}

function renderSegmentTabs() {
    const container = document.getElementById("segment-tabs");
    container.innerHTML = "";
    appData.segments.forEach((seg, i) => {
        const tab = document.createElement("button");
        tab.className = "seg-tab" + (i === currentSegment ? " active" : "");
        const mins = Math.floor(seg.duration / 60);
        const secs = Math.floor(seg.duration % 60);
        tab.textContent = `第 ${i + 1} 段 (${mins}:${secs.toString().padStart(2, "0")})`;
        tab.onclick = () => loadSegment(i);
        container.appendChild(tab);
    });
}

function loadSegment(index) {
    cleanup();
    currentSegment = index;
    currentSentence = 0;
    currentMode = "playback";
    showEn = true;
    showZh = false;

    document.querySelectorAll(".seg-tab").forEach((t, i) => {
        t.classList.toggle("active", i === index);
    });

    const seg = appData.segments[index];
    audio = new Audio(seg.audio_url);

    renderSegmentContent();
}

function renderSegmentContent() {
    const seg = appData.segments[currentSegment];
    const container = document.getElementById("segment-content");

    container.innerHTML = `
        <div class="mode-switcher">
            <button class="mode-btn ${currentMode === 'playback' ? 'active' : ''}" onclick="switchMode('playback')">
                📖 教材播放模式
            </button>
            <button class="mode-btn ${currentMode === 'dictation' ? 'active' : ''}" onclick="switchMode('dictation')">
                ✍️ 聽寫練習模式
            </button>
        </div>

        <div class="player-card">
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill" style="width: ${((currentSentence + 1) / seg.sentences.length) * 100}%"></div>
            </div>

            <div class="counter-row">
                <span class="sentence-counter" id="sentence-counter">
                    第 ${currentSentence + 1} / ${seg.sentences.length} 句
                </span>
                <button class="star-btn ${isFavorited(currentSegment, currentSentence) ? 'on' : ''}"
                        id="star-btn" onclick="toggleFavorite()" title="收藏這句">★</button>
            </div>

            <div class="sentence-display" id="sentence-display">
                <div class="sentence-en ${showEn ? '' : 'sentence-hidden'}" id="en-text">
                    ${seg.sentences[currentSentence].en}
                </div>
                <div class="sentence-zh ${showZh ? '' : 'sentence-hidden'}" id="zh-text">
                    ${seg.sentences[currentSentence].zh}
                </div>
            </div>

            <div class="controls">
                <button class="ctrl-btn" onclick="prevSentence()" title="上一句">⏮</button>
                <button class="ctrl-btn" onclick="replaySentence()" title="重播">🔄</button>
                <button class="ctrl-btn play-btn" id="play-btn" onclick="togglePlay()">▶</button>
                <button class="ctrl-btn" onclick="nextSentence()" title="下一句">⏭</button>
            </div>

            <div class="toggle-btns">
                <button class="toggle-btn ${showEn ? 'on' : ''}" onclick="toggleEn()">英文字幕</button>
                <button class="toggle-btn ${showZh ? 'on' : ''}" onclick="toggleZh()">中文翻譯</button>
            </div>

            <div class="speed-btns">
                <span class="speed-label">速度</span>
                ${[0.75, 1, 1.25].map(s => `
                    <button class="speed-btn ${playbackSpeed === s ? 'on' : ''}"
                            onclick="setSpeed(${s})">${s}x</button>`).join('')}
            </div>

            ${appData.music ? `
            <div class="speed-btns" title="歌詞出現時還在前奏（人聲還沒到）→ 按 +；歌詞出現得太晚 → 按 −">
                <span class="speed-label">歌詞對齊</span>
                <button class="speed-btn" onclick="adjustLyricsOffset(-0.5)">−0.5s</button>
                <span class="speed-label" id="offset-display">${lyricsOffset.toFixed(1)}s</span>
                <button class="speed-btn" onclick="adjustLyricsOffset(0.5)">+0.5s</button>
            </div>` : ''}

            ${currentMode === 'dictation' ? `
                <div class="dictation-area">
                    <div class="timer-bar">
                        <div class="timer-fill" id="timer-fill" style="width: 100%"></div>
                    </div>
                    <input type="text" class="dictation-input" id="dictation-input"
                           placeholder="聽到什麼就打什麼..." onkeydown="if(event.key==='Enter')checkAnswer()" />
                    <div style="text-align:center; margin-top:0.5rem;">
                        <button class="toggle-btn" onclick="checkAnswer()">送出答案</button>
                    </div>
                    <div class="result-display hidden" id="result-display"></div>
                </div>
            ` : ''}
        </div>
    `;
}

function switchMode(mode) {
    cleanup();
    currentMode = mode;
    currentSentence = 0;
    showEn = mode === "playback";
    showZh = false;
    renderSegmentContent();
}

function cleanup() {
    if (audio) {
        audio.pause();
        audio.removeEventListener("timeupdate", sentenceEndHandler);
    }
    isPlaying = false;
    clearTimeout(dictationTimer);
    clearInterval(dictationInterval);
    sentenceEndHandler = null;
}

function updateDisplay() {
    const seg = appData.segments[currentSegment];
    const s = seg.sentences[currentSentence];

    const enEl = document.getElementById("en-text");
    const zhEl = document.getElementById("zh-text");
    const counter = document.getElementById("sentence-counter");
    const progress = document.getElementById("progress-fill");

    if (enEl) {
        enEl.textContent = s.en;
        enEl.classList.toggle("sentence-hidden", !showEn);
    }
    if (zhEl) {
        zhEl.textContent = s.zh;
        zhEl.classList.toggle("sentence-hidden", !showZh);
    }
    if (counter) counter.textContent = `第 ${currentSentence + 1} / ${seg.sentences.length} 句`;
    if (progress) progress.style.width = `${((currentSentence + 1) / seg.sentences.length) * 100}%`;
    const star = document.getElementById("star-btn");
    if (star) star.classList.toggle("on", isFavorited(currentSegment, currentSentence));
}

function playSentence() {
    const seg = appData.segments[currentSegment];
    const s = seg.sentences[currentSentence];

    // 開始播放前，先取消任何待觸發的聽寫倒數，避免計時器疊加
    clearTimeout(dictationTimer);
    clearInterval(dictationInterval);

    if (sentenceEndHandler) {
        audio.removeEventListener("timeupdate", sentenceEndHandler);
    }

    // 音樂模式套用歌詞對齊偏移（+ 表示歌詞時間軸整體往後平移）
    const off = appData.music ? lyricsOffset : 0;
    // 防呆：確保結束時間至少比起點晚一點，避免零長度句造成瞬間結束的迴圈
    const endTime = Math.max(s.end, s.start + 0.4) + off;

    audio.currentTime = Math.max(0, s.start + off);
    audio.playbackRate = playbackSpeed;
    audio.play();
    isPlaying = true;
    document.getElementById("play-btn").textContent = "⏸";

    sentenceEndHandler = () => {
        if (audio.currentTime >= endTime) {
            audio.pause();
            isPlaying = false;
            document.getElementById("play-btn").textContent = "▶";
            audio.removeEventListener("timeupdate", sentenceEndHandler);
            sentenceEndHandler = null;

            if (currentMode === "dictation") {
                startDictationTimer();
            }
        }
    };
    audio.addEventListener("timeupdate", sentenceEndHandler);
}

function togglePlay() {
    if (isPlaying) {
        audio.pause();
        isPlaying = false;
        document.getElementById("play-btn").textContent = "▶";
        if (currentMode === "dictation") {
            clearTimeout(dictationTimer);
            clearInterval(dictationInterval);
        }
    } else {
        playSentence();
    }
}

function replaySentence() {
    clearTimeout(dictationTimer);
    clearInterval(dictationInterval);
    const resultEl = document.getElementById("result-display");
    if (resultEl) resultEl.classList.add("hidden");
    playSentence();
}

function prevSentence() {
    if (currentSentence > 0) {
        cleanup();
        currentSentence--;
        updateDisplay();
        resetDictation();
        playSentence();
    }
}

function nextSentence() {
    const seg = appData.segments[currentSegment];
    if (currentSentence < seg.sentences.length - 1) {
        cleanup();
        currentSentence++;
        updateDisplay();
        resetDictation();
        playSentence();
    }
}

function resetDictation() {
    const input = document.getElementById("dictation-input");
    if (input) input.value = "";
    const result = document.getElementById("result-display");
    if (result) result.classList.add("hidden");
    const timer = document.getElementById("timer-fill");
    if (timer) timer.style.width = "100%";
}

function startDictationTimer() {
    // 啟動前先清掉任何舊計時器，避免多個 interval 疊加造成瘋狂重播
    clearInterval(dictationInterval);
    clearTimeout(dictationTimer);

    dictationCountdown = 10;
    const timerFill = document.getElementById("timer-fill");
    const input = document.getElementById("dictation-input");
    if (input) input.focus();

    // 用區域變數 id，確保倒數結束時清掉的一定是「自己」這個 interval
    const id = setInterval(() => {
        dictationCountdown -= 0.1;
        if (timerFill) {
            timerFill.style.width = `${Math.max(0, (dictationCountdown / 10) * 100)}%`;
        }
        if (dictationCountdown <= 0) {
            clearInterval(id);
            replaySentence();
        }
    }, 100);
    dictationInterval = id;
}

function checkAnswer() {
    clearTimeout(dictationTimer);
    clearInterval(dictationInterval);

    const input = document.getElementById("dictation-input");
    const resultEl = document.getElementById("result-display");
    if (!input || !resultEl) return;

    const seg = appData.segments[currentSegment];
    const s = seg.sentences[currentSentence];
    const userAnswer = input.value.trim().toLowerCase();
    const correct = s.en.toLowerCase().replace(/[^\w\s]/g, "");
    const userClean = userAnswer.replace(/[^\w\s]/g, "");

    resultEl.classList.remove("hidden");

    if (userClean === correct) {
        resultEl.innerHTML = `<span class="result-correct">✓ 完全正確！</span>`;
    } else {
        resultEl.innerHTML = `
            <span class="result-wrong">你的答案：${input.value}</span><br/>
            <span class="result-correct">正確答案：${s.en}</span>
        `;
    }
}

function toggleEn() {
    showEn = !showEn;
    updateDisplay();
    document.querySelectorAll(".toggle-btn")[0].classList.toggle("on", showEn);
}

function toggleZh() {
    showZh = !showZh;
    updateDisplay();
    document.querySelectorAll(".toggle-btn")[1].classList.toggle("on", showZh);
}

document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    switch (e.key) {
        case " ":
            e.preventDefault();
            togglePlay();
            break;
        case "ArrowLeft":
            prevSentence();
            break;
        case "ArrowRight":
            nextSentence();
            break;
        case "r":
            replaySentence();
            break;
    }
});

// 頁面載入時：套用主題、抓影片庫、渲染最愛、綁定網址輸入事件
document.addEventListener("DOMContentLoaded", () => {
    applyTheme(localStorage.getItem("ps_theme") || "dark");
    loadLibrary();
    renderFavorites();
    renderChannels();
    const input = document.getElementById("youtube-url");
    if (input) input.addEventListener("input", () => {
        updateProcessBtnState();
        const star = document.getElementById("fav-channel-star");
        if (star) star.classList.remove("on");  // 換網址 → 重置星星
    });
});
