# Subline — try it out

Subline translates incoming Discord messages and shows them as subtitles
under each message. Fast line first (≈, Google), then a better one
replaces it (✦, AI with conversation context).

## Install — Mac

1. Open **Subline-0.1.0-arm64.dmg** (Apple Silicon) or **-x64** (Intel),
   drag Subline to Applications.
2. It isn't notarized yet, so macOS will refuse the first open:
   **right-click → Open**. If it still refuses: System Settings →
   **Privacy & Security** → scroll down → **Open Anyway**.
3. Click **Install**. It closes Discord, patches it, and starts it again.
   Done when it says so.

## Install — Windows

1. Run **Subline-Setup-0.1.0.exe**.
2. SmartScreen will warn (unsigned): **More info → Run anyway**.
3. Click **Install**. Same flow — it handles Discord itself.

## After installing

- Messages in other languages get a subtitle within ~a second.
- **Better translations (optional, free):** grab a key at
  console.groq.com → API Keys, then in Discord: Settings → **Subline** →
  paste it under Groq API Key. Slang, replies and mixed-language messages
  come out much better.
- DMs are never auto-translated; use the globe button per channel.
  Server channels translate automatically (toggle: Global Auto).

## Good to know

- **When Discord updates**, Subline repairs itself within the hour and
  tells you if Discord needs a restart. Nothing to do.
- Your API key and all settings stay on your machine. Message text goes
  only to the translator (Google / your chosen AI), never anywhere else.
  Nothing is logged.
- **Uninstall:** run Subline again → Uninstall. Discord goes back to
  exactly as it was.

## If something breaks

Tell me what you saw and send me this file:

- Mac: `~/Library/Logs/Subline/subline.log`
- Windows: `%LOCALAPPDATA%\Subline\logs\subline.log`

It contains version numbers and error codes — no message text, ever.
