import { describe, expect, it } from "vitest";
import { collapseElongation, collapseElongationToPair, shouldSkip } from "../skip";

describe("shouldSkip", () => {
    it("skips your own messages", () => {
        expect(shouldSkip("hola amigos", true)).toBe(true);
    });

    it("skips empty and whitespace-only messages", () => {
        expect(shouldSkip("", false)).toBe(true);
        expect(shouldSkip("   \n ", false)).toBe(true);
    });

    it("skips messages that are only custom emotes", () => {
        expect(shouldSkip("<:pepe:123456789>", false)).toBe(true);
        expect(shouldSkip("<a:dance:987> <:kek:654>", false)).toBe(true);
    });

    it("skips messages that are only unicode emoji", () => {
        expect(shouldSkip("😂😂😂", false)).toBe(true);
    });

    it("skips messages that are only links", () => {
        expect(shouldSkip("https://example.com/clip", false)).toBe(true);
    });

    it("skips messages that are only mentions", () => {
        expect(shouldSkip("<@123> <@!456> <#789>", false)).toBe(true);
    });

    it("skips purely numeric messages", () => {
        expect(shouldSkip("2", false)).toBe(true);
        expect(shouldSkip("10 / 10", false)).toBe(true);
    });

    it("translates real text", () => {
        expect(shouldSkip("vamos a jugar", false)).toBe(false);
    });

    it("translates text mixed with a mention", () => {
        expect(shouldSkip("<@123> vamos", false)).toBe(false);
    });

    it("translates short but meaningful words", () => {
        expect(shouldSkip("да", false)).toBe(false);
    });

    it("skips keycap emoji sequences", () => {
        expect(shouldSkip("1️⃣2️⃣3️⃣", false)).toBe(true);
    });

    it("skips lone combining marks", () => {
        expect(shouldSkip("́", false)).toBe(true);
    });

    it("skips Arabic-Indic digits", () => {
        expect(shouldSkip("١٢٣", false)).toBe(true);
    });

    // Real non-Latin text must survive the strip pass and still translate.
    // The first three cases carry category-M characters and so exercise \p{M}
    // directly; the Arabic case has none — it guards the non-Latin/no-ASCII
    // path in general. Each test's own title says which it is.
    it("translates decomposed café (Latin with combining mark)", () => {
        expect(shouldSkip("café", false)).toBe(false);
    });

    it("translates Devanagari script (has virama, category Mn)", () => {
        expect(shouldSkip("नमस्ते", false)).toBe(false);
    });

    it("translates Thai script (has combining marks)", () => {
        expect(shouldSkip("สวัสดี", false)).toBe(false);
    });

    it("translates Arabic script (non-Latin with no ASCII)", () => {
        expect(shouldSkip("مرحبا", false)).toBe(false);
    });
});

describe("shouldSkip — repetition and laughter noise", () => {
    it("skips a message that is one word repeated", () => {
        // Google detected "GOJ GOJ GOJ GOJ" as Esperanto and rendered it as a
        // slur attributed to the sender.
        expect(shouldSkip("GOJ GOJ GOJ GOJ GOJ", false)).toBe(true);
        expect(shouldSkip("NEG NEG NEG NEG", false)).toBe(true);
        expect(shouldSkip("no no no", false)).toBe(true);
    });

    it("skips laughter in several languages", () => {
        for (const s of [
            "JAJAJAJAJ", "jajaja", "hahaha", "ahahahahhaa",
            "kkkkk", "wwww", "xddd", "lolol", "rsrsrs", "55555"
        ]) {
            expect(shouldSkip(s, false), s).toBe(true);
        }
    });

    it("does NOT skip real messages that merely repeat a word", () => {
        // Two DIFFERENT tokens, so the repeated-token rule must not fire.
        expect(shouldSkip("no no puedo", false)).toBe(false);
        expect(shouldSkip("muy muy bueno", false)).toBe(false);
    });

    it("does NOT skip short real words that brush the laughter alphabet", () => {
        expect(shouldSkip("haj", false)).toBe(false);   // under the 4-char floor
        expect(shouldSkip("aha bueno", false)).toBe(false);
        expect(shouldSkip("lo hago", false)).toBe(false);
    });

    it("does NOT skip a sentence that merely contains laughter", () => {
        expect(shouldSkip("jajaja que gracioso", false)).toBe(false);
        expect(shouldSkip("no puedo mas hahaha", false)).toBe(false);
    });
});

describe("shouldSkip — English chat shorthand", () => {
    it("skips messages that are entirely shorthand", () => {
        // Google reads "hbu" as Frisian and "u2 <2" as Chinese, returns them
        // unchanged, and we would render a subtitle identical to the message.
        for (const s of ["hbu", "u2", "u2 <2", "gg wp", "brb", "idk tbh", "kk"]) {
            expect(shouldSkip(s, false), s).toBe(true);
        }
    });

    it("does NOT skip shorthand mixed with real content", () => {
        expect(shouldSkip("hbu, tienes hambre?", false)).toBe(false);
        expect(shouldSkip("gg pero perdimos", false)).toBe(false);
    });
});

describe("collapseElongation", () => {
    it("collapses a run of 3+ identical letters to one", () => {
        expect(collapseElongation("yesssss")).toBe("yes");
        expect(collapseElongation("waiiiiiit")).toBe("wait");
        expect(collapseElongation("lmaoooooo")).toBe("lmao");
        expect(collapseElongation("shhhh")).toBe("sh");
    });

    it("leaves a run of exactly two untouched", () => {
        // "hello"'s "ll" must survive — only the elongated "o" run collapses.
        expect(collapseElongation("helloooooo")).toBe("hello");
        expect(collapseElongation("hello")).toBe("hello");
    });

    it("the threshold is exactly 3 — a run of 2 survives, a run of 3 collapses", () => {
        expect(collapseElongation("soo")).toBe("soo");
        expect(collapseElongation("sooo")).toBe("so");
    });

    it("does not touch a word with no elongation at all", () => {
        expect(collapseElongation("wait")).toBe("wait");
    });

    it("collapses a foreign word's elongation too, without inventing English", () => {
        // Romanian, kept out of every English/foreign evidence list — this is
        // purely about the collapse itself not corrupting non-English text.
        expect(collapseElongation("ceeeee")).toBe("ce");
    });

    it("collapses in a non-Latin script too — this is \\p{L}, not [a-z]", () => {
        expect(collapseElongation("даааа")).toBe("да");
    });

    it("leaves non-letters (repeated punctuation) alone", () => {
        expect(collapseElongation("mor))))")).toBe("mor))))");
    });

    it("collapses a run in each of multiple words independently", () => {
        // Collapse-to-one alone: "goooooood" comes out "god", not "good" —
        // this function on its own gets a base word with a doubled letter
        // wrong. See collapseElongationToPair below for the other half.
        expect(collapseElongation("goooooood morninggggg")).toBe("god morning");
    });
});

describe("collapseElongationToPair", () => {
    it("collapses a run of 3+ identical letters to exactly two", () => {
        expect(collapseElongationToPair("goooooood")).toBe("good");
        expect(collapseElongationToPair("coooool")).toBe("cool");
    });

    it("leaves a run of exactly two untouched, same as collapseElongation", () => {
        expect(collapseElongationToPair("hello")).toBe("hello");
    });

    it("leaves a word with no elongation untouched", () => {
        expect(collapseElongationToPair("wait")).toBe("wait");
    });

    it("gets the SINGLE-letter case wrong on its own — that is why both forms are needed", () => {
        // "yess" is not "yes": collapsing to two is exactly as one-sided as
        // collapsing to one, just for the opposite class of base word.
        expect(collapseElongationToPair("yesssss")).toBe("yess");
        expect(collapseElongationToPair("lmaoooooo")).toBe("lmaoo");
    });
});

describe("shouldSkip — elongated chat interjections", () => {
    it("skips the user's real elongated examples", () => {
        for (const s of [
            "yesssss", "waiiiiiit", "helloooooo", "lmaoooooo",
            "goooooood morninggggg", "shhhh"
        ]) {
            expect(shouldSkip(s, false), s).toBe(true);
        }
    });

    it("skips a doubled-letter base word via the collapse-to-TWO form, with no dictionary artefact", () => {
        // "goooooood" alone (no "morning" alongside it) only matches through
        // collapseElongationToPair ("good") — collapseElongation alone would
        // produce "god", which is not (and does not need to be) in
        // CHAT_SHORTHAND. Proves the pair-form path, not the single-form one.
        expect(shouldSkip("goooooood", false)).toBe(true);
    });

    it("does NOT skip a doubled-letter word that was never added to any list — proves the mechanism adds no words on its own", () => {
        // collapseElongationToPair("coooool") is "cool" (see its own test
        // above), a perfectly plausible chat word — but "cool" was never
        // added to CHAT_SHORTHAND, so trying both forms must not skip this
        // by itself. If this ever starts failing, something started matching
        // words that were never deliberately added.
        expect(shouldSkip("coooool", false)).toBe(false);
    });

    it("does NOT skip an elongated foreign word", () => {
        // "ceeeee" collapses to "ce" (one form) / "cee" (the other), neither
        // in any shorthand/evidence list, so it must still be sent.
        expect(shouldSkip("ceeeee", false)).toBe(false);
    });

    it("does NOT skip another elongated Romanian word", () => {
        // "waiii" collapses to "wai" / "waii" — neither is "wait" (4 letters,
        // one "t"), so this must not collide with the "wait" entry.
        expect(shouldSkip("waiii", false)).toBe(false);
    });

    it("does NOT skip elongated punctuation-only noise as if it were a word", () => {
        // "mor))))" strips down to "mor" via the existing punctuation pass,
        // which is not chat shorthand, so this must still translate.
        expect(shouldSkip("mor))))", false)).toBe(false);
    });

    it("does NOT skip elongated shorthand mixed with real content", () => {
        expect(shouldSkip("yesssss pero no puedo hoy", false)).toBe(false);
    });

    it("still requires the WHOLE message to be shorthand after collapsing", () => {
        // 3 tokens, under the length cap, but "what" is not shorthand — the
        // membership check (not just the token-count cap) must still reject
        // this.
        expect(shouldSkip("yesssss wait what", false)).toBe(false);
    });
});
