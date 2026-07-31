# GCash Kiosk

A Raspberry Pi touchscreen kiosk for Cash In and Cash Out transactions, receipt capture, Telegram notifications, and a timed guest Wi-Fi QR hotspot.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

For Raspberry Pi installation and kiosk auto-start, follow [RASPBERRY_PI_SETUP.txt](RASPBERRY_PI_SETUP.txt).

## Private settings

Copy `kiosk_settings.example.json` to `kiosk_settings.json`, then enter the kiosk's own Telegram and network settings. Do not commit `kiosk_settings.json`: it is intentionally ignored because it can contain private credentials.

Generated receipt images are also ignored to avoid uploading customer data.
