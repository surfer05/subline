# Windows A-Z field test, 6-8 Oct 2026 (v0.2.2): fix list

Owner decisions are final. Copy rules: short plain sentences, no em dashes, never say "Plugins" or "VcTranslate" (the settings page is "Subline → Settings"). No phrase-specific or language-specific word lists in prompts.

## Installer (installer/)
- I1. A failed uninstall still removed the plugin settings (the code), leaving Subline patched and "Not activated". Remove settings only after every restore succeeded.
- I2. The update path (Subline already in Discord, no code saved) skips the activation screen. With no code, show "Activate Subline".
- I3. Uninstall "DISCORD_RUNNING": detection is correct (Discord hidden behind the Windows 11 tray overflow ^). Fix the screen: offer to quit Discord on the first uninstall screen like install does; message "Discord is still open in the background, behind the ^ near the clock."; "Quit Discord and remove" is the main button. Fix any copy that only says "check the system tray".
- I4. Code screen copy is too heavy. Use: heading "Activate Subline"; line "$4.99, once."; field label "Code"; hint "Bought it? The code is in the email from Dodo Payments. Check spam."; link "Lost your code?" (Dodo customer portal, as now).
- I5. A wrong code shows the generic "What went wrong · IO_ERROR" box (flow.ts activationError always uses IO_ERROR). For wrong-code / claimed / rate-limit answers show only the message line, no diagnostics box.
- I6. After a restart mid-checkout the installer starts again at Welcome. If a reading language is already chosen and no code is saved, resume at "Activate Subline".
- I7. The "Finish paying in your browser" screen: add "Using a VPN? Turn it off only while you pay. Discord can stay on." and a way back (Back / Try again).

## Plugin (src/userplugins/vcTranslate/)
- P1 (HIGH, sells AI). A used ✦ preview must: show "Translating…" at once; ignore a second press on the same message; never charge twice for one message; show the FULL ✦ text (never cut with "…"); REPLACE the ≈ line (one line, not a second line); KEEP the "Add AI" nudge on that line. "✦ reads this the same way." must not exist as a separate result: the ✦ text simply replaces ≈.
- P2. DM/channel button "off" state shows a struck ≈ icon. Use a globe (dimmed or slashed) for off.
- P3. Add AI panel copy: title "Add AI"; one line "✦ reads the whole conversation, so slang and replies come out right."; buttons "$1.99 a month" and "$19.99 a year · Save 16%"; footnote "Coupon? Enter it on the payment page." Remove the price table and "Pay in your browser…".
- P4. After a checkout is opened, show "Payment being confirmed" instead of "Add AI" (plan card, ⚡, panel) while polling; never offer a second purchase meanwhile.
- P5. When AI switches on, close/refresh an open Add AI panel and hide "Add AI" everywhere.
- P6 (HIGH). Context ring: messages that are cache hits, in flight or phrase-reused are never recorded into the context ring (enqueue). Record every message the reader sees, in chronological order (verify catch-up order), deduped.
- P7. qualityPhrases reuse ignores context: do not reuse for short context-dependent lines (decide a safe rule, e.g. only reuse when the context is identical or the text is long).
- P8. Debug log: log the number of context lines per ✦ batch (no text), so "out of context" reports can be checked.
- P9 (MUST TEST). Relay down while Discord works: timeout, DNS failure, 5xx, 429, malformed JSON, very slow reply. ≈ keeps working on every surface; ✦ fails quietly (no toasts or error spam); no preview spent and nothing charged; recovers by itself.

## Relay (relay/)
- R1 (HIGH). An AI subscriber can start a second subscription: handleCheckoutV2 refuses already_owned only for "automatic". Refuse monthly/annual when AI is already active.
- R2 (HIGH). Double pay before the first webhook: keep a short-lived checkout-open marker per install and kind; before selling again, ask Dodo for that session's status (or refuse with purchase_pending for a short window). An abandoned checkout must not block a later purchase for long.
- R3 (HIGH). Reply links dropped: normalizeBatch keeps only id/text/author. Keep replyToId (validated) and tell the model in the prompt which message each reply answers (by id, whether that message is in the batch or in the context).
- R4 (HIGH). Promo claims are limited to 3 per IPv4 or IPv6 /48 per UTC day; VPN users share exit addresses, so server drives fail. Count per install; keep a much looser per-address cap only as abuse protection. Keep the 20-failures limit for guessing.
- R5. One general prompt principle, no word lists or examples: when a word or phrase has more than one reading, choose the reading that makes sense as a reply to the earlier messages; casual and romanized text often uses small words that turn a sentence into a question, a joke or a "not really". Add eval cases (in the eval set, not the prompt): after "coffee w no meals is prolly not a good idea", "daaru thodi pi rha 😛" must mean "it's not like I'm drinking booze"; plus a few fresh Hinglish context cases (e.g. "accha" as agreement / surprise / "I see"). Run the eval only if the key and budget allow, and report numbers.
- R6 (MUST TEST). refund.succeeded / dispute.lost / dispute.accepted revoke the code; refund pending/review/failed and open disputes do not. Test the client sees "Not activated" at its next entitlement check, and document that delay.
- R7. Public purchase status for the thanks page: GET /v1/purchase-status?payment_id=…|subscription_id=… → {"state":"active"|"pending"|"failed"|"unknown"}. No personal data, rate-limited, ids validated.
- R8. CHECKOUT_RETURN_URL and any site links → https://subline.page (the old github.io address redirects, keep working).

## Site (design/site → site/index.html via scripts/buildSite.mjs; deployed to gh-pages, which has a CNAME file "subline.page" that must be kept)
- S1. Thanks page is chosen once from the return URL and never updates. Poll R7 every few seconds for up to a few minutes and switch to "You're all set."; if still pending, say "Check Subline → Settings in Discord. It shows your plan."
- S2. On the thanks page, do not render the full home page (hero "Download for Windows") under the message.
- S3. AI thanks text says "Your code is also in your email": for an AI purchase the Discord code does not change; drop that line for AI.
- S4. Failed/cancelled page: add "Using a VPN? Turn it off only while you pay. Discord can stay on."
- S5. Page /buy: buy Automatic on any device (for people whose VPN must stay on); after checkout the thanks page shows the code to enter under "I have a code".
- S6. Canonical/og URLs → https://subline.page.

## Not now
- Feedback box in Settings (ask the owner for details first).
- Tax-inclusive pricing and the Indian bank ₹1 mandate line (India is not a target market).
