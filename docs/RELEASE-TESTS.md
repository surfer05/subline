# Release tests (real machines, required)

No release that touches startup, repair, install or uninstall ships until every step below passes on BOTH the Mac and the Windows PC. If any step shows something else, stop and send a screenshot plus diagnostics.

Two rules these tests protect:
1. A user who paid never opens Discord and finds Subline gone.
2. Discord always starts, even when Subline is broken.

Subline's mod folder:
- Mac: `~/Library/Application Support/Subline/mod`
- Windows: `%LOCALAPPDATA%\Subline\mod`

To quit Discord fully on Windows: click the ^ near the clock, right-click Discord, Quit Discord.

## A. Install and start (both computers)
1. Quit Discord. Install the new build (Mac: DMG to Applications; Windows: Setup.exe from the site).
2. Finish the installer. It opens Discord.
3. Open a channel with foreign messages. You see ≈ lines. With AI, ✦ lines.
4. Subline → Settings shows the new version and build.

## B. Discord starts when Subline is broken (both computers)
1. Quit Discord.
2. Rename the mod folder to `mod-test` (Mac: Finder, Go to Folder; Windows: File Explorer, paste the path).
3. Open Discord. It MUST open normally (no Subline, no crash, no white screen).
4. Within a few minutes a Subline alert says its files are missing.
5. Quit Discord. Rename `mod-test` back to `mod`. Open Discord. Translations are back.

## C. Restart (both computers)
1. Quit and reopen Discord twice. Translations work each time. No code is asked for.
2. Restart the computer. Open Discord. Translations work.

## D. Discord update (Mac)
1. Quit Discord.
2. Download Discord from discord.com and replace Discord in Applications (this acts like an update).
3. Open Discord. Within a minute Subline is back (or a notice asks you to quit and reopen once). After that, translations work.

## E. Discord update (Windows)
A fresh Discord install does not prove this. Wait for the next real Discord update:
1. Note the Discord version (Settings, bottom left) before and after.
2. After the update, within 5 minutes (or after the notice to quit and reopen), translations work again.
3. If not: send `diagnostics.txt` (Subline app, Copy diagnostics).

## F. Uninstall and reinstall (both computers)
1. Open the Subline app, Uninstall. With Discord open, the first screen offers to quit it.
2. Keep "Also remove my settings and code" unticked. Remove. Discord opens without Subline.
3. Reinstall from the site. No activation screen; the same code and plan are back.
4. Uninstall again with the box ticked. Reinstall: your plan comes back by itself (this computer is remembered). On a computer that never had Subline, the activation screen shows.

## G. After release
- The daily patch check on GitHub is green.
- No patch-health alert email arrives in the first day.
