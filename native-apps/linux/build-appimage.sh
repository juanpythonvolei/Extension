#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"
APPDIR="$SCRIPT_DIR/.Continuum.AppDir"
RUNTIME_BIN="$SCRIPT_DIR/.appimage-runtime-x86_64"
PAYLOAD_TGZ="$SCRIPT_DIR/.appdir-payload.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$APPDIR" "$RUNTIME_BIN" "$PAYLOAD_TGZ"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/continuum" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/icons/hicolor/scalable/apps" "$APPDIR/usr/share/metainfo"

cp "$SCRIPT_DIR/continuum_app.py" "$APPDIR/usr/share/continuum/continuum_app.py"
chmod 755 "$APPDIR/usr/share/continuum/continuum_app.py"

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
set -e
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="${APPDIR:-$HERE}"

PY=""
for cand in /usr/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk" >/dev/null 2>&1; then
    PY="$cand"
    break
  fi
done

if [ -z "$PY" ]; then
  for cand in /usr/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c "import tkinter" >/dev/null 2>&1; then
      PY="$cand"
      break
    fi
  done
fi

if [ -z "$PY" ]; then
  PY="$(command -v python3 2>/dev/null || echo /usr/bin/python3)"
fi

exec "$PY" "$HERE/usr/share/continuum/continuum_app.py" "$@"
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
X-AppImage-Version=4.0.0
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

# Compile Zero-FUSE static x86_64 ELF AppImage runtime (works on Zorin OS 16/17, Ubuntu 20-24, Fedora, Arch without libfuse2!)
gcc -O2 -Wall -Wextra -s -static "$SCRIPT_DIR/appimage_runtime.c" -o "$RUNTIME_BIN"
tar -czf "$PAYLOAD_TGZ" -C "$APPDIR" .

python3 - "$RUNTIME_BIN" "$PAYLOAD_TGZ" "$OUT_DIR/Continuum-Linux-x86_64.AppImage" <<'PY'
import struct, sys
runtime_path, payload_path, out_path = sys.argv[1:4]
runtime = open(runtime_path, "rb").read()
payload = open(payload_path, "rb").read()
footer = b"CONT_APPIMG_V1" + bytes(2) + struct.pack("<QQ", len(runtime), len(payload))
with open(out_path, "wb") as f:
    f.write(runtime)
    f.write(payload)
    f.write(footer)
PY

chmod +x "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
rm -rf "$APPDIR" "$RUNTIME_BIN" "$PAYLOAD_TGZ"
ls -lh "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
