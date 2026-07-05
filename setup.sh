#!/usr/bin/env bash
# Patrick Speak 一鍵安裝腳本
# 用法：在終端機切到這個資料夾後執行 ./setup.sh
set -e

cd "$(dirname "$0")"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

echo -e "${BOLD}=== Patrick Speak 安裝程式 ===${NC}"
echo ""

# 1. 檢查 Homebrew
if ! command -v brew >/dev/null 2>&1; then
    err "沒有找到 Homebrew。"
    echo "  請先到 https://brew.sh 依照網站指示安裝，安裝完成後重新執行本腳本。"
    exit 1
fi
ok "Homebrew 已安裝"

# 2. 安裝系統工具：yt-dlp, ffmpeg, whisper-cpp
echo ""
echo "正在檢查系統工具（yt-dlp / ffmpeg / whisper-cpp）..."
for pkg in yt-dlp ffmpeg whisper-cpp; do
    if brew list "$pkg" >/dev/null 2>&1; then
        ok "$pkg 已安裝"
    else
        echo "  安裝 $pkg ..."
        brew install "$pkg"
        ok "$pkg 安裝完成"
    fi
done

# 3. 檢查 Ollama
echo ""
if ! command -v ollama >/dev/null 2>&1; then
    warn "沒有找到 Ollama（負責把英文翻譯成中文）。"
    echo "  請選一種方式安裝："
    echo "    A) 圖形介面：到 https://ollama.com/download 下載 Ollama App，安裝後打開它一次"
    echo "    B) 終端機一行安裝：curl -fsSL https://ollama.com/install.sh | sh"
    echo "       （這個方式會直接啟動背景服務，那個終端機視窗會顯示服務日誌、"
    echo "        看起來像卡住但其實是正常的——直接開一個新的終端機視窗繼續操作即可）"
    echo "  安裝完成後重新執行本腳本。"
    exit 1
fi
ok "Ollama 已安裝"

if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    warn "Ollama 目前沒有在執行。"
    echo "  請啟動 Ollama：打開 Ollama App，或在終端機執行 \`ollama serve\`（會佔用該視窗顯示日誌，"
    echo "  是正常現象），然後開一個新的終端機視窗重新執行本腳本。"
    exit 1
fi
ok "Ollama 正在執行"

# 3b. 下載翻譯模型（若尚未下載）
MODEL_NAME="translategemma:latest"
echo ""
if curl -s http://localhost:11434/api/tags | grep -q "translategemma"; then
    ok "翻譯模型 $MODEL_NAME 已存在"
else
    echo "正在下載翻譯模型 $MODEL_NAME（約數 GB，需要一點時間，請耐心等候）..."
    ollama pull "$MODEL_NAME"
    ok "翻譯模型下載完成"
fi

# 4. 建立 Python 虛擬環境並安裝套件
echo ""
if [ ! -d ".venv" ]; then
    echo "正在建立 Python 虛擬環境..."
    python3 -m venv .venv
fi
ok "Python 虛擬環境就緒"

echo "正在安裝 Python 套件..."
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
ok "Python 套件安裝完成"

# 5. 下載 Whisper 語音辨識模型
echo ""
mkdir -p models
MODEL_PATH="models/ggml-small.en.bin"
if [ -f "$MODEL_PATH" ]; then
    ok "Whisper 模型已存在"
else
    echo "正在下載 Whisper 英文語音辨識模型（約 466MB，需要一點時間，請耐心等候）..."
    curl -L -o "$MODEL_PATH" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
    ok "Whisper 模型下載完成"
fi

echo ""
echo -e "${GREEN}${BOLD}安裝完成！${NC}"
echo ""
echo "接下來執行以下指令啟動："
echo -e "  ${BOLD}./start.sh${NC}"
