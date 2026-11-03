#!/usr/bin/env bash
# Package "V Studio.app" as a drag-to-Applications .dmg.
#   packaging/macos/build_dmg.sh 1.0.0
set -euo pipefail
VERSION="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/build/dist/V Studio.app"
OUT="$ROOT/build/installers"
ARCH="$(uname -m)"
STAGE="$ROOT/build/dmg"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT/V-Studio-${VERSION}-macOS-${ARCH}.dmg"
rm -f "$DMG"
hdiutil create -volname "V Studio" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
ls -lh "$OUT"

