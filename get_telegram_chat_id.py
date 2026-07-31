import getpass
import json
import urllib.request
import urllib.error


def main():
    token = getpass.getpass("Paste Telegram bot token (hidden): ").strip()
    if not token:
        raise SystemExit("No bot token provided.")

    url = f"https://api.telegram.org/bot{token}/getUpdates"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Telegram returned HTTP {error.code}.") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Could not contact Telegram: {error}") from error

    if not data.get("ok"):
        raise SystemExit(data.get("description", "Telegram request failed."))

    chats = {}
    for update in data.get("result", []):
        message = (
            update.get("message")
            or update.get("edited_message")
            or update.get("channel_post")
            or update.get("edited_channel_post")
        )
        if not message:
            continue
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            continue
        label = chat.get("title") or " ".join(
            part for part in [chat.get("first_name"), chat.get("last_name")] if part
        ) or chat.get("username") or "Unnamed chat"
        chats[str(chat_id)] = label

    if not chats:
        print("No chats found. Open your bot in Telegram, tap Start, send a message, then run this helper again.")
        return

    print("\nRecent Telegram chats:")
    for chat_id, label in chats.items():
        print(f"  Chat ID: {chat_id}  |  {label}")


if __name__ == "__main__":
    main()
