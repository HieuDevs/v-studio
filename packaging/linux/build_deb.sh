#!/usr/bin/env bash
# Package the PyInstaller build as a .deb and a .tar.gz.
#   packaging/linux/build_deb.sh 1.0.0
set -euo pipefail
VERSION="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/build/dist/VStudio"
OUT="$ROOT/build/installers"
ARCH="$(dpkg --print-architecture)"
PKG="$ROOT/build/deb/v-studio_${VERSION}_${ARCH}"

rm -rf "$PKG"
mkdir -p "$PKG/DEBIAN" "$PKG/opt/v-studio" "$PKG/usr/bin" \
         "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/512x512/apps" "$OUT"
cp -a "$DIST/." "$PKG/opt/v-studio/"
ln -s /opt/v-studio/VStudio "$PKG/usr/bin/v-studio"
if [ -f "$ROOT/packaging/icon-512.png" ]; then
  cp "$ROOT/packaging/icon-512.png" "$PKG/usr/share/icons/hicolor/512x512/apps/v-studio.png"
fi

cat > "$PKG/usr/share/applications/v-studio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=V Studio
Comment=Vietnamese text-to-speech
Exec=/opt/v-studio/VStudio
Icon=v-studio
Terminal=false
Categories=AudioVideo;Audio;Utility;
EOF

SIZE_KB="$(du -sk "$PKG/opt" | cut -f1)"

# Libraries the bundled binaries link to directly (ELF NEEDED) that are not shipped in the bundle,
# mapped to their packages on the build machine. Package names change between Ubuntu releases
# (e.g. t64 renames, libunistring2 -> 5), so these go to Recommends: apt installs them when they
# exist but never refuses to install the app. Depends keeps a short list that exists everywhere.
BUNDLED=$(find "$DIST" -type f -name '*.so*' -exec basename {} \; | sort -u)
NEEDED=$(find "$DIST" -type f \( -name '*.so*' -o -perm -u+x \) -exec sh -c 'file -b "$1" | grep -q ELF && readelf -d "$1" 2>/dev/null' _ {} \; \
  | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort -u)
SYS_LIBS=$(for n in $NEEDED; do echo "$BUNDLED" | grep -qxF "$n" && continue; ldconfig -p | awk -v n="$n" '$1==n && /x86-64|x86_64/ {print $NF; exit}'; done | sort -u)
echo "System libraries linked directly: $(echo $SYS_LIBS | wc -w)"
RECOMMENDS=$(for l in $SYS_LIBS; do dpkg -S "$(readlink -f "$l")" 2>/dev/null || dpkg -S "$l" 2>/dev/null; done \
  | cut -d: -f1 | sort -u | grep -v -E '^(libc6|libgcc-s1|libstdc\+\+6)$' \
  | awk '{ if ($0 ~ /t64$/) print $0; else print $0 " | " $0 "t64" }' | paste -sd, - | sed 's/,/, /g')
DEPENDS="libc6, libportaudio2, libsndfile1, libnss3, libxkbcommon-x11-0, libxcb-cursor0, libegl1, libgl1, libfontconfig1, libdbus-1-3, libwayland-server0, libwayland-client0, libwayland-cursor0, libwayland-egl1, libasound2 | libasound2t64"
echo "Depends: $DEPENDS"
echo "Recommends: $RECOMMENDS"

cat > "$PKG/DEBIAN/control" <<EOF
Package: v-studio
Version: ${VERSION}
Section: sound
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${SIZE_KB}
Depends: ${DEPENDS}
Recommends: ${RECOMMENDS}
Maintainer: HieuDevs <noreply@github.com>
Homepage: https://github.com/HieuDevs/v-studio
Description: V Studio - Vietnamese text-to-speech desktop app
 Turn Vietnamese text into natural speech, clone voices, make
 conversations and dub subtitles. Runs fully offline after the first launch.
EOF

dpkg-deb --root-owner-group --build "$PKG" "$OUT/V-Studio-${VERSION}-Linux-${ARCH}.deb"
tar -C "$ROOT/build/dist" -czf "$OUT/V-Studio-${VERSION}-Linux-${ARCH}.tar.gz" VStudio
ls -lh "$OUT"

