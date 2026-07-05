#!/usr/bin/env bash
# Patrick Speak 啟動腳本
# 用法：在終端機切到這個資料夾後執行 ./start.sh
set -e

cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    echo "尚未安裝，請先執行 ./setup.sh"
    exit 1
fi

if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "⚠️  偵測不到 Ollama 在執行，翻譯功能可能會失敗。"
    echo "   請啟動 Ollama（打開 Ollama App，或終端機執行 ollama serve）後再試一次，"
    echo "   或直接繼續，稍後再開也可以。"
    echo ""
fi

echo "正在啟動 Patrick Speak ..."
echo "啟動完成後，請到瀏覽器開啟： http://localhost:8000"
echo "（結束使用時回到這個視窗，按 Ctrl + C 即可關閉）"
echo ""

# 稍等伺服器啟動後自動開啟瀏覽器
( sleep 2 && open "http://localhost:8000" >/dev/null 2>&1 ) &

.venv/bin/uvicorn backend.main:app --port 8000
