#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"
APPDIR="$SCRIPT_DIR/.Continuum.AppDir"
mkdir -p "$OUT_DIR"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/continuum" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/icons/hicolor/scalable/apps" "$APPDIR/usr/share/metainfo"

cp "$SCRIPT_DIR/continuum_app.py" "$APPDIR/usr/share/continuum/continuum_app.py"
chmod 755 "$APPDIR/usr/share/continuum/continuum_app.py"

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
set -e
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="${APPDIR:-$HERE}"
exec python3 "$HERE/usr/share/continuum/continuum_app.py" "$@"
EOF
chmod 755 "$APPDIR/AppRun"
cp "$APPDIR/AppRun" "$APPDIR/usr/bin/continuum"

cat > "$APPDIR/continuum.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Native Device Mesh
Comment=Aplicativo Nativo Linux GTK 3 para Malha de Dispositivos (Malha MESH01)
Exec=continuum
Icon=continuum
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=continuum_app.py
X-AppImage-Version=2.0.0
EOF
chmod 644 "$APPDIR/continuum.desktop"
cp "$APPDIR/continuum.desktop" "$APPDIR/usr/share/applications/continuum.desktop"

cat > "$APPDIR/usr/share/metainfo/app.continuum.mesh.appdata.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>app.continuum.mesh</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <name>Continuum</name>
  <summary>Aplicativo nativo GTK 3 para malha de dispositivos, trackpad remoto e clipboard universal</summary>
  <description>
    <p>Continuum conecta dispositivos Linux, Windows e Android em tempo real com aplicativo desktop nativo GTK 3, sem navegador e sem WebView.</p>
  </description>
  <launchable type="desktop-id">continuum.desktop</launchable>
</component>
EOF

if [ -f "$SCRIPT_DIR/assets/continuum.png" ]; then
  cp "$SCRIPT_DIR/assets/continuum.png" "$APPDIR/continuum.png"
  cp "$SCRIPT_DIR/assets/continuum.png" "$APPDIR/.DirIcon"
  cp "$SCRIPT_DIR/assets/continuum.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/continuum.png"
fi
if [ -f "$SCRIPT_DIR/assets/continuum.svg" ]; then
  cp "$SCRIPT_DIR/assets/continuum.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/continuum.svg"
fi

APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"
if ! command -v "$APPIMAGETOOL" >/dev/null 2>&1 && [ ! -x "$APPIMAGETOOL" ]; then
  APPIMAGETOOL="$SCRIPT_DIR/.appimagetool-x86_64.AppImage"
  if [ ! -x "$APPIMAGETOOL" ]; then
    echo "Baixando appimagetool-x86_64.AppImage..."
    curl -fsSL -o "$APPIMAGETOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$APPIMAGETOOL"
  fi
fi

ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run --no-appstream "$APPDIR" "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
chmod +x "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
rm -rf "$APPDIR"
ls -lh "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
