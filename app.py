from flask import Flask, render_template, request, jsonify
import qrcode
import io
import base64
import os
import time
import json
import secrets
import string
import subprocess
import threading
import urllib.request
import urllib.error
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

SETTINGS_PATH = os.path.join(os.path.dirname(__file__), "kiosk_settings.json")


def load_settings():
    settings = {
        "telegram_bot_token": "",
        "telegram_chat_id": "",
        "receipt_upload_key": "",
        "wifi_hotspot_enabled": True,
        "wifi_primary_interface": "wlan0",
        "wifi_hotspot_interface": "wlan1",
        "wifi_hotspot_ssid": "Jessie's Guest WiFi",
        "wifi_shortcut_key": "",
    }

    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as file:
            loaded = json.load(file)
            if isinstance(loaded, dict):
                settings.update(loaded)
    except (OSError, ValueError):
        pass

    env_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    env_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    env_upload_key = os.environ.get("RECEIPT_UPLOAD_KEY", "").strip()
    env_wifi_shortcut_key = os.environ.get("WIFI_SHORTCUT_KEY", "").strip()

    if env_token:
        settings["telegram_bot_token"] = env_token
    if env_chat_id:
        settings["telegram_chat_id"] = env_chat_id
    if env_upload_key:
        settings["receipt_upload_key"] = env_upload_key
    if env_wifi_shortcut_key:
        settings["wifi_shortcut_key"] = env_wifi_shortcut_key

    return settings


def format_phone(phone):
    digits = "".join(ch for ch in str(phone) if ch.isdigit())[:11]
    if len(digits) == 11:
        return f"{digits[:4]} {digits[4:7]} {digits[7:]}"
    return digits


def telegram_api_request(method, payload):
    settings = load_settings()
    bot_token = str(settings.get("telegram_bot_token", "")).strip()

    if not bot_token or bot_token.startswith("PASTE_"):
        return False, "Telegram bot token is not configured.", None

    url = f"https://api.telegram.org/bot{bot_token}/{method}"
    request_data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=request_data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            response_data = json.loads(response.read().decode("utf-8"))
            if 200 <= response.status < 300 and response_data.get("ok"):
                return True, "Telegram message sent.", response_data.get("result")
            return False, response_data.get("description", f"Telegram returned HTTP {response.status}."), None
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8"))
            description = body.get("description", f"Telegram returned HTTP {error.code}.")
        except (ValueError, UnicodeDecodeError):
            description = f"Telegram returned HTTP {error.code}."
        return False, description, None
    except (urllib.error.URLError, TimeoutError) as error:
        return False, f"Telegram request failed: {error}", None


def send_telegram_transaction(phone, amount, fee, total):
    settings = load_settings()
    chat_id = str(settings.get("telegram_chat_id", "")).strip()

    if not chat_id or chat_id.startswith("PASTE_"):
        return False, "Telegram chat ID is not configured."

    phone_digits = "".join(ch for ch in str(phone) if ch.isdigit())[:11]
    text = (
        "New GCash Cash In\n\n"
        f"Mobile number\n{format_phone(phone_digits)}\n\n"
        f"Cash in amount\n₱{amount:,.2f}\n"
        f"Processing fee\n₱{fee:,.2f}\n"
        f"Total to pay\n₱{total:,.2f}"
    )

    payload = {
        "chat_id": chat_id,
        "text": text,
        "reply_markup": {
            "inline_keyboard": [[
                {
                    "text": "Copy number",
                    "copy_text": {"text": phone_digits},
                }
            ]]
        },
    }

    success, message, _ = telegram_api_request("sendMessage", payload)
    return success, message


# Your exact extracted baseline string
MY_GCASH_BASE_STRING = "00020101021127830012com.p2pqrpay0111GXCHPHM2XXX02089996440303152170200000006560417DWQM4TK3JDO2HKTOF5204601653036085802PH5910MA****U B.6006Tagpos6104123463042616"

RECEIPT_DIR = os.path.join(app.static_folder, "receipts")
os.makedirs(RECEIPT_DIR, exist_ok=True)
LATEST_RECEIPT = {
    "available": False,
    "image_url": "",
    "uploaded_at": 0,
    "phone": "",
    "amount": "",
    "note": "",
}

WIFI_HOTSPOT_DURATION_SECONDS = 5 * 60
WIFI_HOTSPOT_HELPER = "/usr/local/sbin/gcash-kiosk-hotspot"
WIFI_HOTSPOT_LOCK = threading.RLock()
WIFI_HOTSPOT_TIMER = None
WIFI_HOTSPOT = {
    "active": False,
    "interface": "",
    "ssid": "",
    "password": "",
    "expires_at": 0,
    "popup_id": "",
}


def crc16_ccitt_false(data: str) -> str:
    crc = 0xFFFF
    polynomial = 0x1021
    for byte in data.encode("utf-8"):
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ polynomial
            else:
                crc <<= 1
    return f"{crc & 0xFFFF:04X}"


def make_dynamic_qr(base_str: str, amount: float) -> str:
    elements = []
    i = 0
    while i < len(base_str):
        tag = base_str[i:i + 2]
        length = int(base_str[i + 2:i + 4])
        value = base_str[i + 4:i + 4 + length]
        elements.append([tag, value])
        i = i + 4 + length

    for item in elements:
        if item[0] == "01":
            item[1] = "12"
            break

    elements = [item for item in elements if item[0] != "63"]
    amount_str = f"{amount:.2f}"

    found_tag_54 = False
    for item in elements:
        if item[0] == "54":
            item[1] = amount_str
            found_tag_54 = True
            break
    if not found_tag_54:
        elements.append(["54", amount_str])

    payload = ""
    for tag, val in sorted(elements, key=lambda x: x[0]):
        payload += f"{tag}{len(val):02d}{val}"

    payload += "6304"
    return payload + crc16_ccitt_false(payload)


def clear_receipt_state():
    global LATEST_RECEIPT
    for name in os.listdir(RECEIPT_DIR):
        try:
            os.remove(os.path.join(RECEIPT_DIR, name))
        except OSError:
            pass

    LATEST_RECEIPT = {
        "available": False,
        "image_url": "",
        "uploaded_at": 0,
        "phone": "",
        "amount": "",
        "note": "",
    }


def setting_is_enabled(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def wifi_qr_escape(value):
    return str(value).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace(":", "\\:")


def make_wifi_qr_data_url(ssid, password):
    payload = f"WIFI:T:WPA;S:{wifi_qr_escape(ssid)};P:{wifi_qr_escape(password)};;"
    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(payload)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    image_buffer = io.BytesIO()
    image.save(image_buffer, format="PNG")
    encoded = base64.b64encode(image_buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def generate_wifi_password():
    alphabet = string.ascii_uppercase + string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(12))


def run_wifi_hotspot_helper(action, interface, primary_interface="", ssid="", password=""):
    command = ["sudo", "-n", WIFI_HOTSPOT_HELPER, action, interface]
    input_text = None
    if action == "start":
        command.extend([primary_interface, ssid, str(WIFI_HOTSPOT_DURATION_SECONDS)])
        input_text = f"{password}\n"

    try:
        result = subprocess.run(
            command,
            input=input_text,
            text=True,
            capture_output=True,
            timeout=25,
            check=False,
        )
    except FileNotFoundError:
        return False, "The Pi hotspot helper is not installed. Run install_pi.sh again."
    except subprocess.TimeoutExpired:
        return False, "The Pi hotspot command timed out."
    except OSError:
        return False, "The Pi could not run the hotspot command."

    if result.returncode == 0:
        return True, ""

    detail = (result.stderr or result.stdout or "").strip().splitlines()
    safe_detail = detail[-1].strip() if detail else "Unknown Pi hotspot error."
    return False, safe_detail[:220]


def clear_wifi_hotspot_state():
    global WIFI_HOTSPOT, WIFI_HOTSPOT_TIMER
    if WIFI_HOTSPOT_TIMER is not None:
        WIFI_HOTSPOT_TIMER.cancel()
        WIFI_HOTSPOT_TIMER = None
    WIFI_HOTSPOT = {
        "active": False,
        "interface": "",
        "ssid": "",
        "password": "",
        "expires_at": 0,
        "popup_id": "",
    }


def stop_wifi_hotspot():
    with WIFI_HOTSPOT_LOCK:
        interface = WIFI_HOTSPOT.get("interface") or str(load_settings().get("wifi_hotspot_interface", "wlan1"))
        run_wifi_hotspot_helper("stop", interface)
        clear_wifi_hotspot_state()


def expire_wifi_hotspot():
    stop_wifi_hotspot()


def local_kiosk_request():
    return request.remote_addr in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


def wifi_hotspot_response():
    return {
        "success": True,
        "active": True,
        "ssid": WIFI_HOTSPOT["ssid"],
        "password": WIFI_HOTSPOT["password"],
        "expires_at": WIFI_HOTSPOT["expires_at"],
        "popup_id": WIFI_HOTSPOT["popup_id"],
        "qr_image": make_wifi_qr_data_url(WIFI_HOTSPOT["ssid"], WIFI_HOTSPOT["password"]),
    }


def wifi_shortcut_authorized():
    configured_key = str(load_settings().get("wifi_shortcut_key", "")).strip()
    supplied_keys = [request.headers.get("X-Kiosk-Shortcut-Key", "").strip()]
    shortcut_body = request.get_json(silent=True)
    if isinstance(shortcut_body, dict):
        supplied_keys.append(str(shortcut_body.get("key", "")).strip())
    return bool(configured_key) and any(
        supplied_key and secrets.compare_digest(supplied_key, configured_key)
        for supplied_key in supplied_keys
    )


def start_wifi_hotspot():
    global WIFI_HOTSPOT_TIMER, WIFI_HOTSPOT

    settings = load_settings()
    if not setting_is_enabled(settings.get("wifi_hotspot_enabled")):
        return False, None, "The guest Wi-Fi hotspot is disabled in kiosk_settings.json."

    interface = str(settings.get("wifi_hotspot_interface", "wlan1")).strip()
    primary_interface = str(settings.get("wifi_primary_interface", "wlan0")).strip()
    ssid = str(settings.get("wifi_hotspot_ssid", "Jessie's Guest WiFi")).strip()
    if not interface or not primary_interface or not ssid:
        return False, None, "The guest Wi-Fi hotspot settings are incomplete."

    with WIFI_HOTSPOT_LOCK:
        now = int(time.time())
        if WIFI_HOTSPOT["active"] and WIFI_HOTSPOT["expires_at"] > now:
            WIFI_HOTSPOT["popup_id"] = secrets.token_urlsafe(12)
            return True, wifi_hotspot_response(), ""

        if WIFI_HOTSPOT["active"]:
            stop_wifi_hotspot()

        password = generate_wifi_password()
        started, error = run_wifi_hotspot_helper("start", interface, primary_interface, ssid, password)
        if not started:
            return False, None, f"Guest Wi-Fi could not start: {error}"

        WIFI_HOTSPOT = {
            "active": True,
            "interface": interface,
            "ssid": ssid,
            "password": password,
            "expires_at": now + WIFI_HOTSPOT_DURATION_SECONDS,
            "popup_id": secrets.token_urlsafe(12),
        }
        WIFI_HOTSPOT_TIMER = threading.Timer(WIFI_HOTSPOT_DURATION_SECONDS, expire_wifi_hotspot)
        WIFI_HOTSPOT_TIMER.daemon = True
        WIFI_HOTSPOT_TIMER.start()
        return True, wifi_hotspot_response(), ""


def receipt_upload_authorized():
    configured_key = str(load_settings().get("receipt_upload_key", "")).strip()
    if not configured_key:
        return True

    supplied_key = (
        request.form.get("key")
        or request.args.get("key")
        or request.headers.get("X-Receipt-Key")
        or ""
    ).strip()
    return supplied_key == configured_key


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/generate", methods=["POST"])
def generate():
    data = request.json or {}
    amount = float(data.get("amount", 0))

    if amount <= 0:
        return jsonify({"error": "Invalid amount"}), 400

    final_payload = make_dynamic_qr(MY_GCASH_BASE_STRING, amount)

    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(final_payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    img_buffer = io.BytesIO()
    img.save(img_buffer, format="PNG")
    base64_str = base64.b64encode(img_buffer.getvalue()).decode("utf-8")

    return jsonify({
        "success": True,
        "qr_image": f"data:image/png;base64,{base64_str}",
        "reference": "KIOSK-" + str(abs(hash(final_payload)))[-6:],
    })


@app.route("/api/wifi-hotspot", methods=["POST"])
def wifi_hotspot():
    if not local_kiosk_request():
        return jsonify({"success": False, "error": "This action is available only from the kiosk screen."}), 403

    started, response, error = start_wifi_hotspot()
    if not started:
        return jsonify({"success": False, "error": error}), 503
    return jsonify(response)


@app.route("/api/wifi-hotspot/status", methods=["GET"])
def wifi_hotspot_status():
    if not local_kiosk_request():
        return jsonify({"success": False, "error": "This action is available only from the kiosk screen."}), 403

    with WIFI_HOTSPOT_LOCK:
        if not WIFI_HOTSPOT["active"] or WIFI_HOTSPOT["expires_at"] <= int(time.time()):
            return jsonify({"success": True, "active": False})
        return jsonify(wifi_hotspot_response())


@app.route("/api/wifi-hotspot/shortcut", methods=["POST"])
def wifi_hotspot_shortcut():
    if not wifi_shortcut_authorized():
        return jsonify({"success": False, "error": "Invalid iPhone Shortcut key."}), 401

    started, response, error = start_wifi_hotspot()
    if not started:
        return jsonify({"success": False, "error": error}), 503

    return jsonify({
        "success": True,
        "message": "The WiFi QR popup has opened on the kiosk.",
        "expires_at": response["expires_at"],
    })


@app.route("/api/cashin-notify", methods=["POST"])
def cashin_notify():
    data = request.json or {}
    phone = "".join(ch for ch in str(data.get("phone", "")) if ch.isdigit())

    try:
        amount = float(data.get("amount", 0))
        fee = float(data.get("fee", 0))
        total = float(data.get("total", amount + fee))
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "Invalid transaction values."}), 400

    if len(phone) != 11:
        return jsonify({"success": False, "error": "Phone number must contain 11 digits."}), 400
    if amount <= 0 or fee < 0 or total <= 0:
        return jsonify({"success": False, "error": "Invalid transaction amount."}), 400

    success, message = send_telegram_transaction(phone, amount, fee, total)
    status = 200 if success else 503
    return jsonify({"success": success, "message": message}), status


@app.route("/api/telegram/test", methods=["POST"])
def telegram_test():
    settings = load_settings()
    chat_id = str(settings.get("telegram_chat_id", "")).strip()
    if not chat_id or chat_id.startswith("PASTE_"):
        return jsonify({"success": False, "error": "Telegram chat ID is not configured."}), 400

    success, message, _ = telegram_api_request(
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": "GCash kiosk Telegram connection is working.",
        },
    )
    return jsonify({"success": success, "message": message}), 200 if success else 503


@app.route("/api/receipt-share", methods=["POST"])
def receipt_share():
    global LATEST_RECEIPT

    if not receipt_upload_authorized():
        return jsonify({"error": "Invalid receipt upload key."}), 403

    # Accept either:
    # 1) multipart/form-data with a file field named receipt/file/image, or
    # 2) a raw image/file request body from Apple Shortcuts Request Body: File.
    upload = (
        request.files.get("receipt")
        or request.files.get("file")
        or request.files.get("image")
    )

    raw_data = b""
    original_name = ""
    content_type = (request.content_type or "").split(";", 1)[0].strip().lower()

    if upload is not None and upload.filename:
        original_name = upload.filename
    elif content_type.startswith("image/") or content_type == "application/octet-stream":
        raw_data = request.get_data(cache=False)
        original_name = request.headers.get("X-Filename", "receipt")
        if not raw_data:
            return jsonify({"error": "The request body was empty."}), 400
    else:
        return jsonify({
            "error": "No receipt image provided.",
            "received_content_type": request.content_type,
            "received_file_fields": list(request.files.keys()),
            "received_form_fields": list(request.form.keys()),
            "hint": "In Apple Shortcuts, use POST and set Request Body to File, then choose Converted Image."
        }), 400

    ext = os.path.splitext(original_name)[1].lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext_by_type = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
        }
        ext = ext_by_type.get(content_type, ".jpg")

    clear_receipt_state()

    timestamp = int(time.time())
    filename = secure_filename(f"receipt_{timestamp}{ext}")
    full_path = os.path.join(RECEIPT_DIR, filename)

    if upload is not None and upload.filename:
        upload.save(full_path)
    else:
        with open(full_path, "wb") as output_file:
            output_file.write(raw_data)

    phone = (request.form.get("phone") or request.args.get("phone") or "").strip()
    amount = (request.form.get("amount") or request.args.get("amount") or "").strip()
    note = (request.form.get("note") or request.args.get("note") or "").strip()

    LATEST_RECEIPT = {
        "available": True,
        "image_url": f"/static/receipts/{filename}",
        "uploaded_at": timestamp,
        "phone": phone,
        "amount": amount,
        "note": note,
    }
    return jsonify({"success": True, **LATEST_RECEIPT})


@app.route("/api/receipt/latest", methods=["GET"])
def receipt_latest():
    return jsonify(LATEST_RECEIPT)


@app.route("/api/receipt/clear", methods=["POST"])
def receipt_clear():
    clear_receipt_state()
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
