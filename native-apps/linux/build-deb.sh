#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"
STAGE="$SCRIPT_DIR/.deb-stage"
rm -rf "$STAGE" "$OUT_DIR"
mkdir -p "$OUT_DIR" "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/share/continuum" "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/scalable/apps" "$STAGE/usr/share/icons/hicolor/512x512/apps"

cp "$SCRIPT_DIR/continuum_app.py" "$STAGE/usr/share/continuum/continuum_app.py"
chmod 755 "$STAGE/usr/share/continuum/continuum_app.py"

cat > "$STAGE/usr/bin/continuum" <<'EOF'
#!/usr/bin/env bash
exec python3 /usr/share/continuum/continuum_app.py "$@"
EOF
chmod 755 "$STAGE/usr/bin/continuum"

cat > "$STAGE/usr/share/applications/continuum.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Native Device Mesh
Comment=Aplicativo Nativo Linux GTK 3 para Malha de Dispositivos (Malha MESH01)
Exec=/usr/bin/continuum
Icon=continuum
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=continuum_app.py
EOF
chmod 644 "$STAGE/usr/share/applications/continuum.desktop"

if [ -f "$SCRIPT_DIR/assets/continuum.svg" ]; then
  cp "$SCRIPT_DIR/assets/continuum.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/continuum.svg"
  chmod 644 "$STAGE/usr/share/icons/hicolor/scalable/apps/continuum.svg"
fi
if [ -f "$SCRIPT_DIR/assets/continuum.png" ]; then
  cp "$SCRIPT_DIR/assets/continuum.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/continuum.png"
  chmod 644 "$STAGE/usr/share/icons/hicolor/512x512/apps/continuum.png"
fi

INSTALLED_KB="$(du -sk "$STAGE/usr" | awk '{print $1}')"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: continuum-mesh
Version: 5.1.0
Section: utils
Priority: optional
Architecture: all
Installed-Size: ${INSTALLED_KB}
Depends: python3, python3-gi, gir1.2-gtk-3.0
Recommends: xdotool, wmctrl, pulseaudio-utils | wireplumber, playerctl, libnotify-bin
Maintainer: Continuum <support@continuum.local>
Homepage: http://localhost:3000
Description: Continuum 5.1 - Aplicativo Nativo Linux (Extensao de Tela + KVM + Clipboard Auto)
 Aplicativo desktop nativo em GTK 3 + Cairo 60 FPS com 5 espacos de trabalho,
 Extensao de Monitor/Segunda Tela em tempo real via LAN, Mouse e Teclado Continuo (KVM),
 Area de Transferencia Universal Automatica e protocolo LAN Zero-Loop v5.1.
EOF
chmod 644 "$STAGE/DEBIAN/control"

cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
pkill -f "/usr/share/continuum/continuum_app.py" >/dev/null 2>&1 || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postrm"

(cd "$STAGE" && find usr -type f -exec md5sum {} + > DEBIAN/md5sums)
chmod 644 "$STAGE/DEBIAN/md5sums"

dpkg-deb --root-owner-group -Zgzip --build "$STAGE" "$OUT_DIR/Continuum-Linux-amd64.deb"
tar -czf "$OUT_DIR/Continuum-Linux-Portable.tar.gz" -C "$SCRIPT_DIR" continuum_app.py assets
rm -rf "$STAGE"
ls -lh "$OUT_DIR"
