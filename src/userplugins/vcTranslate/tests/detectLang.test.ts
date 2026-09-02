import { describe, expect, it } from "vitest";
import { isConfidentlyTargetLanguage } from "../detectLang";

const en = (text: string) => isConfidentlyTargetLanguage(text, "en");

describe("isConfidentlyTargetLanguage — real messages that must NOT cost a request", () => {
    // Every string in this block was actually sent to the API on the user's
    // free tier, from the Gemini usage dashboard. They are the reason this
    // module exists, so they are pinned verbatim.
    it("recognises a casual English sentence", () => {
        expect(en("we should have a fst mc server")).toBe(true);
    });

    it("recognises English with emoji attached", () => {
        expect(en("hello everyone good luck 🌞🌿")).toBe(true);
    });

    it("recognises English mixed with chat shorthand and emoji", () => {
        expect(en("gl love and hii to berto 😭❤️")).toBe(true);
    });

    it("recognises a long English paragraph", () => {
        expect(en(
            "there was an earthquake here last night and everything in my room "
            + "was shaking for like 30 seconds, i really thought the building "
            + "was going to come down. we all went outside and stayed there "
            + "until the morning because nobody wanted to go back in"
        )).toBe(true);
    });
});

describe("isConfidentlyTargetLanguage — must be sent", () => {
    it("sends Spanish", () => {
        expect(en("no puedo jugar hoy porque tengo que estudiar para el examen")).toBe(false);
        expect(en("que tal amigos como estan todos")).toBe(false);
    });

    it("sends Arabic", () => {
        expect(en("مرحبا كيف حالك اليوم")).toBe(false);
    });

    it("sends an English sentence containing a single Arabic word", () => {
        // The script check is zero-tolerance on purpose: one foreign word in
        // an otherwise-English sentence is exactly the case where a wrong
        // answer loses the translation the user needed.
        expect(en("i think he said مرحبا to everyone in the channel")).toBe(false);
    });

    it("sends other non-Latin scripts", () => {
        expect(en("привет как дела сегодня")).toBe(false);
        expect(en("今日はみんな元気ですか")).toBe(false);
        expect(en("γεια σου τι κανεις σημερα")).toBe(false);
    });

    it("sends Latin-script text carrying accented characters", () => {
        expect(en("estás muy lejos de aquí ahora")).toBe(false);
        expect(en("você não vai jogar com a gente")).toBe(false);
    });

    it("sends a message with English loanwords but a foreign majority", () => {
        // Hit count alone would accept this ("sorry", "thanks"); the ratio is
        // what rejects it.
        expect(en("sorry po, hindi ko alam kung ano ang gagawin dito, thanks")).toBe(false);
    });
});

describe("isConfidentlyTargetLanguage — ambiguous short messages are always sent", () => {
    // A false positive here is invisible: no subtitle, no marker, and the user
    // has no way to know a translation was silently dropped. So anything this
    // short is sent, even when it looks English.
    it("sends short messages with no real signal", () => {
        expect(en("yess")).toBe(false);
        expect(en("gl")).toBe(false);
        expect(en("ok")).toBe(false);
        expect(en("lol")).toBe(false);
    });

    it("sends a single English function word", () => {
        // "this" IS in the English evidence list. One token is still not
        // enough to place a message.
        expect(en("THIS")).toBe(false);
    });

    it("sends a message that is only emoji, mentions or links", () => {
        expect(en("😂😂😂")).toBe(false);
        expect(en("<@123> <@456>")).toBe(false);
        expect(en("https://example.com/clip")).toBe(false);
    });

    it("sends an English-length message with only one English word", () => {
        // One hit can be coincidence in almost any language; two independent
        // hits are the bar.
        expect(en("berto kwan mikael the")).toBe(false);
    });
});

describe("isConfidentlyTargetLanguage — only English is implemented", () => {
    it("returns false for every other target language, whatever the text", () => {
        // A heuristic tuned for English applied to a language nobody reasoned
        // about would silently drop translations. No heuristic beats a wrong
        // one, so every other target is unconditionally "send it".
        for (const lang of ["es", "pt", "ja", "de", "fr", "ru", ""]) {
            expect(isConfidentlyTargetLanguage("the cat is on the table and it is fine", lang)).toBe(false);
            expect(isConfidentlyTargetLanguage("estás muy lejos de aquí ahora mismo", lang)).toBe(false);
        }
    });

    it("does not treat a Spanish message as already-Spanish for a Spanish target", () => {
        // The tempting-but-unwritten feature: this WOULD be the right answer,
        // and returning it would require a Spanish-specific evidence set that
        // does not exist. Until it does, the honest answer is false.
        expect(isConfidentlyTargetLanguage("hola como estan todos ustedes hoy", "es")).toBe(false);
    });
});

describe("isConfidentlyTargetLanguage — elongated words inside a sentence", () => {
    it("counts an elongated English word as evidence, not just its neighbours", () => {
        // "there" alone is one ENGLISH_WORDS hit — under MIN_ENGLISH_HITS (2).
        // "hello" only becomes the second hit once "helloooo" is collapsed
        // back to it; without the collapse this sentence returns false.
        expect(en("helloooo there friend")).toBe(true);
    });

    it("still rejects a foreign message whose only elongated word is foreign", () => {
        // "ceeeee" (Romanian) collapses to "ce" — not in ENGLISH_WORDS, not in
        // FOREIGN_WORDS (Romanian has no veto list here) — so this has zero
        // signal either way and must stay "false" under the asymmetry, exactly
        // as an un-elongated Romanian sentence would. The collapse must not
        // manufacture an English hit out of it.
        expect(en("ceeeee bine multumesc")).toBe(false);
    });

    it("an elongated Spanish function word still trips the foreign veto", () => {
        // "graciaaaas" collapses to "gracias", which IS in FOREIGN_WORDS — the
        // veto must still fire post-collapse, not just the evidence count.
        expect(en("graciaaaas amigos bueno")).toBe(false);
    });

    it("counts a DOUBLED-letter elongated word as evidence too — the collapse-to-two form", () => {
        // "goooooood" only matches ENGLISH_WORDS's "good" via the
        // collapse-to-TWO form (collapseElongationToPair) — the collapse-to-
        // one form produces "god", which is not in ENGLISH_WORDS. "there" is
        // the other hit. Without trying both forms this returns false.
        expect(en("goooooood there friend")).toBe(true);
    });

    it("does not manufacture a hit for a doubled-letter word nobody added to ENGLISH_WORDS", () => {
        // "coooool" collapses to "col" / "cool" — neither is in ENGLISH_WORDS
        // (only "good" was already there), so — same shape as the "ceeeee"/
        // "waiii" cases above — this has zero signal and must stay false.
        // Proves trying both forms adds no evidence beyond what already
        // exists in the list, even for a plausible-looking chat word.
        expect(en("coooool bine multumesc")).toBe(false);
    });

    it("does not falsely veto or credit another elongated Romanian word", () => {
        // "waiii" collapses to "wai" / "waii" — neither is in FOREIGN_WORDS
        // or ENGLISH_WORDS, so this has zero signal either way, same as the
        // "ceeeee" case above.
        expect(en("waiii bine multumesc")).toBe(false);
    });

    // THE SCREENSHOT OF 2026-09-02: "Good luckk🍀", "helloo hellooo", "break",
    // "good luck!", "welcome and gl" — a wall of English small talk wearing
    // "⚠ translation failed", because every one of them is under MIN_TOKENS
    // and the gate refuses to classify short messages at all. Short messages
    // are where chat LIVES; a gate that abstains on them abstains on most of
    // the traffic. They get their own rule: every token must be on a list of
    // words vetted to be English-only — no entry that is also a function word
    // in any veto language, which is what makes 1-2 token confidence safe.
    describe("short messages of unambiguous English", () => {
        it.each([
            "Good luckk🍀",
            "good luck!",
            "helloo hellooo",
            "break",
            "welcome",
            "hi yall",
            "good morning",
            "thanks guys"
        ])("skips %j locally", text => {
            expect(isConfidentlyTargetLanguage(text, "en")).toBe(true);
        });

        it.each([
            ["was", "German 'what'"],
            ["die", "German 'the'"],
            ["si", "Spanish/Italian 'yes'"],
            ["Glucks🍀", "German Glücks minus the umlaut"],
            ["hi yall gll", "gll is not a word anyone vetted"],
            ["gut", "German 'good'"]
        ])("still sends %j (%s)", text => {
            expect(isConfidentlyTargetLanguage(text, "en")).toBe(false);
        });
    });
});
