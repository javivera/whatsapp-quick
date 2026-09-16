#!/bin/sh
# Build, sign locally, and install WhatsApp Quick to /Applications.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_dir=${CARGO_TARGET_DIR:-$HOME/Library/Caches/whatsapp-quick/cargo-target}
app_name="WhatsApp Quick.app"
built_app="$target_dir/release/bundle/macos/$app_name"
installed_app="/Applications/$app_name"
tauri_bin="$project_dir/node_modules/.bin/tauri"

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "quick:install is only supported on macOS." >&2
    exit 1
    ;;
esac

if [ ! -x "$tauri_bin" ]; then
  echo "Tauri CLI not found at $tauri_bin" >&2
  echo "Run 'npm install' in $project_dir first." >&2
  exit 1
fi

cd "$project_dir"

echo "Building $app_name..."
CARGO_TARGET_DIR="$target_dir" "$tauri_bin" build --bundles app

if [ ! -d "$built_app" ]; then
  echo "Build completed, but the app bundle was not found at: $built_app" >&2
  exit 1
fi

echo "Signing the completed local app bundle..."
/usr/bin/codesign --force --deep --sign - "$built_app"

echo "Installing $app_name in /Applications..."
if /bin/rm -rf -- "$installed_app" 2>/dev/null &&
   /usr/bin/ditto "$built_app" "$installed_app" 2>/dev/null; then
  :
else
  echo "Administrator access is required to write to /Applications."
  sudo /bin/rm -rf "$installed_app"
  sudo /usr/bin/ditto "$built_app" "$installed_app"
fi

echo "Installed: $installed_app"
