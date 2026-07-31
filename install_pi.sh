#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="$(id -un)"
AUTOSTART_FILE="$HOME/.config/labwc/autostart"
SERVICE_FILE="/etc/systemd/system/gcash-kiosk.service"
START_SCRIPT="$APP_DIR/pi/start-kiosk.sh"
HOTSPOT_HELPER_SOURCE="$APP_DIR/pi/gcash-kiosk-hotspot"
HOTSPOT_HELPER_TARGET="/usr/local/sbin/gcash-kiosk-hotspot"
SUDOERS_FILE="/etc/sudoers.d/gcash-kiosk-hotspot"

printf '\nInstalling GCash kiosk from:\n  %s\n\n' "$APP_DIR"

sudo apt update
sudo apt install -y python3-venv python3-pip chromium curl unzip network-manager iw

python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/python" -m pip install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

mkdir -p "$APP_DIR/static/receipts"
chmod +x "$START_SCRIPT"
sudo install -o root -g root -m 0755 "$HOTSPOT_HELPER_SOURCE" "$HOTSPOT_HELPER_TARGET"
printf '%s ALL=(root) NOPASSWD: %s start *, %s stop *\n' "$APP_USER" "$HOTSPOT_HELPER_TARGET" "$HOTSPOT_HELPER_TARGET" | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chmod 440 "$SUDOERS_FILE"
sudo visudo -cf "$SUDOERS_FILE"

sed \
    -e "s|__USER__|$APP_USER|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    "$APP_DIR/pi/gcash-kiosk.service.template" | sudo tee "$SERVICE_FILE" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now gcash-kiosk.service

mkdir -p "$(dirname "$AUTOSTART_FILE")"
touch "$AUTOSTART_FILE"
AUTOSTART_LINE="$START_SCRIPT &"
if ! grep -Fqx "$AUTOSTART_LINE" "$AUTOSTART_FILE"; then
    {
        printf '\n# GCash kiosk\n'
        printf '%s\n' "$AUTOSTART_LINE"
    } >> "$AUTOSTART_FILE"
fi

printf '\nInstallation complete.\n\n'
printf 'Before rebooting:\n'
printf '  1. Edit: %s/kiosk_settings.json\n' "$APP_DIR"
printf '  2. Enable Desktop Autologin in: sudo raspi-config\n'
printf '  3. Disable screen blanking in: sudo raspi-config\n'
printf '  4. Set the Waveshare display orientation to Left or Right in the desktop Screens settings.\n\n'
printf 'Test backend now:\n  curl http://127.0.0.1:5000\n\n'
printf 'Then reboot:\n  sudo reboot\n\n'
