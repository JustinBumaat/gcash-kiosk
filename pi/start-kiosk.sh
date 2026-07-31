#!/usr/bin/env bash
set -u

APP_URL="http://127.0.0.1:5000"

# Wait until the local Flask server is ready.
for _ in $(seq 1 90); do
    if curl -fsS "$APP_URL" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Avoid duplicate Chromium windows if the desktop session restarts autostart.
pkill -f "chromium.*127.0.0.1:5000" 2>/dev/null || true
sleep 1

exec chromium "$APP_URL" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-session-crashed-bubble \
    --password-store=basic \
    --disable-features=Translate,TranslateUI \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --enable-features=OverlayScrollbar \
    --start-maximized \
    --force-device-scale-factor=1 \
    --window-size=480,800
