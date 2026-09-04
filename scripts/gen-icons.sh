#!/usr/bin/env bash
# 从 assets/icons/ 的源 SVG 生成 public/ 下的全部位图图标。
# 依赖：macOS 自带 qlmanage（SVG→PNG）与 sips（缩放）。
# 源文件：
#   public/favicon.svg            圆角瓷贴版（浏览器标签 / PWA any）
#   assets/icons/icon-bleed.svg   全出血方形（iOS apple-touch-icon）
#   assets/icons/icon-maskable.svg 全出血 + 安全区（PWA maskable）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROUNDED="$ROOT/public/favicon.svg"
SRC_BLEED="$ROOT/assets/icons/icon-bleed.svg"
SRC_MASKABLE="$ROOT/assets/icons/icon-maskable.svg"
OUT="$ROOT/public/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# qlmanage 输出尺寸可能带约束，统一按目标尺寸重采样
gen() { # gen <src.svg> <render_size> <out_size> <dest>
  qlmanage -t -s "$2" -o "$TMP" "$1" >/dev/null 2>&1
  local raw="$TMP/$(basename "$1").png"
  if [[ "$2" != "$3" ]]; then
    sips -z "$3" "$3" "$raw" --out "$TMP/resized.png" >/dev/null
    raw="$TMP/resized.png"
  fi
  sips -s format png "$raw" --out "$4" >/dev/null
}

mkdir -p "$OUT"
gen "$SRC_ROUNDED"  512 512 "$OUT/icon-512.png"
gen "$SRC_ROUNDED"  512 192 "$OUT/icon-192.png"
gen "$SRC_ROUNDED"  512  32 "$OUT/icon-32.png"
gen "$SRC_BLEED"    512 180 "$OUT/apple-touch-icon.png"
gen "$SRC_MASKABLE" 512 512 "$OUT/maskable-512.png"
gen "$SRC_MASKABLE" 512 192 "$OUT/maskable-192.png"

echo "OK -> $OUT"
ls -la "$OUT"
