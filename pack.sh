#!/usr/bin/env bash
# 打包成可以傳給朋友的 zip（排除 .venv、audio_cache、下載的模型等本機專屬檔案）
set -e

cd "$(dirname "$0")"

NAME="PatrickSpeak"
OUT="${NAME}.zip"

echo "正在打包 ${OUT} ..."

rm -f "$OUT"

zip -rq "$OUT" . \
    -x ".venv/*" \
    -x "audio_cache/*" \
    -x "models/*.bin" \
    -x ".claude/*" \
    -x ".git/*" \
    -x "__pycache__/*" \
    -x "*.pyc" \
    -x ".env" \
    -x "youtube_cookies.txt" \
    -x ".DS_Store" \
    -x "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "完成：${OUT}（${SIZE}）"
echo ""
echo "傳給朋友後，請他們："
echo "  1. 解壓縮"
echo "  2. 開終端機切到解壓縮後的資料夾"
echo "  3. 執行 ./setup.sh（第一次安裝，會自動下載模型）"
echo "  4. 執行 ./start.sh（之後每次啟動）"
