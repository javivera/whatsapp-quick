#!/bin/sh
# Build the WhatsApp Quick .app bundle (no install).
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_dir=${CARGO_TARGET_DIR:-$HOME/Library/Caches/whatsapp-quick/cargo-target}
tauri_bin="$project_dir/node_modules/.bin/tauri"

if [ ! -x "$tauri_bin" ]; then
  echo "Tauri CLI not found at $tauri_bin" >&2
  echo "Run 'npm install' in $project_dir first." >&2
  exit 1
fi

cd "$project_dir"
echo "Building WhatsApp Quick..."
CARGO_TARGET_DIR="$target_dir" "$tauri_bin" build --bundles app

echo "Built: $target_dir/release/bundle/macos/WhatsApp Quick.app"
