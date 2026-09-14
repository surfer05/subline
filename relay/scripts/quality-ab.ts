/**
 * Translation-quality A/B harness.
 *
 * Runs the EXACT relay prompt (buildPrompt) through every candidate model on a
 * set of deliberately tricky messages, and prints them side by side so a human
 * who knows the languages can judge. This is NOT a unit test — it hits live
 * paid APIs, so it never runs in `npm test`. You run it with your OWN keys:
 *
 *   GEMINI_KEY=... GROQ_KEY=... npx tsx scripts/quality-ab.ts
 *   OPENROUTER_KEY=... npx tsx scripts/quality-ab.ts        # to include qwen etc.
 *
 * A model whose key env is missing is skipped (so you can run gemini-only, etc).
 * Add your own real Discord lines to scripts/quality-cases.json (see bottom).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPrompt, type BatchRequest } from "../src/translate";

// ---- The models under test ------------------------------------------------
// keyEnv gates whether a row runs. Edit model ids freely — if one 404s the row
// just prints the error and the rest continue.
type Kind = "groq" | "gemini" | "openrouter";
interface Model { label: string; kind: Kind; model: string; keyEnv: string; priceIn: number; priceOut: number }
const MODELS: Model[] = [
    { label: "gpt-oss-120b (CURRENT)", kind: "groq",       model: "openai/gpt-oss-120b",     keyEnv: "GROQ_KEY",       priceIn: 0.15, priceOut: 0.60 },
    { label: "qwen3-32b (Groq)",       kind: "groq",       model: "qwen/qwen3-32b",          keyEnv: "GROQ_KEY",       priceIn: 0.29, priceOut: 0.59 },
    { label: "qwen-2.5-72b (OpenRtr)", kind: "openrouter", model: "qwen/qwen-2.5-72b-instruct", keyEnv: "OPENROUTER_KEY", priceIn: 0.40, priceOut: 0.40 },
    { label: "Gemini 3.8 Flash",       kind: "gemini",     model: "gemini-3.8-flash",        keyEnv: "GEMINI_KEY",     priceIn: 0.75, priceOut: 3.75 },
    { label: "Gemini 3.1 Flash-Lite",  kind: "gemini",     model: "gemini-3.1-flash-lite",   keyEnv: "GEMINI_KEY",     priceIn: 0.25, priceOut: 1.50 },
    { label: "Gemini 2.5 Flash-Lite",  kind: "gemini",     model: "gemini-2.5-flash-lite",   keyEnv: "GEMINI_KEY",     priceIn: 0.10, priceOut: 0.40 },
];

// ---- The tricky cases -----------------------------------------------------
// `expect` is the intended reading, for the human grader — the model never sees
// it. `context` (optional) is prior lines the model may use but must not
// translate. Target is the READER's language.
interface Case { text: string; target: string; note: string; expect: string; author?: string; context?: { author: string; text: string }[] }
const DEFAULT_CASES: Case[] = [
    { text: "arey uske room se tomar ke PG aa gaya shaam ko", target: "English", author: "rahul",
      note: "Romanised Hindi. 'arey' = filler 'dude', not a name; 'PG' = a paying-guest lodging.",
      expect: "Dude, the guy from Tomar's PG showed up from his room this evening." },
    { text: "beta thoda dhyaan se chalaya kar gaadi", target: "English", author: "uncle",
      note: "Address-term trap: 'beta' is affectionate ('kid/son'), not literal parentage.",
      expect: "Kid, drive a bit more carefully." },
    { text: "that's so og fr fr no cap", target: "English", author: "z",
      note: "English slang for an English reader — must SKIP (translating it is the bug).",
      expect: "[skip]" },
    { text: "Landooo pole gng gng", target: "English", author: "q",
      note: "Gibberish / usernames — no translatable meaning, must SKIP (detectors call this Tagalog).",
      expect: "[skip]" },
    { text: "3aycha m3a a5oya w 7na ghadyin l dar", target: "English", author: "yassine",
      note: "Romanised Maghrebi Arabic with digit-letters (3=ع, 7=ح, 5=خ). Ordinary chat, not errors.",
      expect: "I'm living with my brother and we're heading home." },
    { text: "bro yeh assignment ka scene lowkey sus hai", target: "English", author: "ankit",
      note: "Hinglish code-switch; keep 'lowkey/sus' as the same register in English.",
      expect: "Bro, this whole assignment situation is lowkey sus." },
    { text: "abe saale kitni der lagata hai yaar", target: "English", author: "v",
      note: "Profanity must STAY profanity — don't soften 'saale' into 'friend'.",
      expect: "Oi bastard, how long are you gonna take, man." },
    { text: "queue pe aao Valorant ki ranked khelni hai", target: "English", author: "op",
      note: "Proper noun + game terms: 'Valorant', 'ranked', 'queue' stay untranslated.",
      expect: "Hop in the queue, we gotta play Valorant ranked." },
    { text: "💀💀 bruh", target: "English", author: "z",
      note: "Emoji + English — must SKIP, not describe the emoji.",
      expect: "[skip]" },
    { text: "no manches güey, qué pedo con eso", target: "English", author: "diego",
      note: "Mexican slang; 'qué pedo' is 'what's up', not literal.",
      expect: "No way dude, what's up with that." },
    { text: "wesh le sang ça passe crème", target: "English", author: "sofiane",
      note: "French banlieue slang; 'le sang' = 'bro', 'crème' = 'smoothly'.",
      expect: "Yo bro, it's all going great." },
    { text: "kurban olduğum nasılsın", target: "English", author: "mert",
      note: "Turkish 'sacrifice' address-term trap → affectionate 'my dear', not literal sacrifice.",
      expect: "How are you, my dear?" },
    { text: "bas ghar", target: "English", author: "rahul",
      note: "Short reply that only makes sense from context (answering 'where are you going?').",
      expect: "Just home.",
      context: [{ author: "sara", text: "arey kaha ja rahe ho itni raat ko" }] },
    { text: "the meeting got pushed to tomorrow, kinda annoying ngl", target: "Hindi", author: "boss",
      note: "Reverse direction: English INTO Hindi. Should read like natural Hinglish chat, not stiff formal Hindi.",
      expect: "(natural Hindi, e.g.) yaar meeting kal pe shift ho gayi, thoda annoying hai ngl" },
];

// ---- Provider callers (mirror src/translate.ts) ---------------------------
const GEMINI_SCHEMA = { type: "object", properties: { translations: { type: "array", items: {
    type: "object", properties: { id: { type: "string" }, lang: { type: "string" }, text: { type: "string" }, skip: { type: "boolean" } },
    required: ["id", "skip"] } } }, required: ["translations"] };

interface Raw { content: string; inTok: number; outTok: number }

async function callGroqLike(endpoint: string, prompt: string, key: string, model: string): Promise<Raw> {
    const reasoning = /gpt-oss|qwen|reasoning|deepseek-r/i.test(model)
        ? { reasoning_effort: "low", reasoning_format: "hidden" } : {};
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, ...reasoning })
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const b: any = await res.json();
    return { content: b?.choices?.[0]?.message?.content ?? "", inTok: b?.usage?.prompt_tokens ?? 0, outTok: b?.usage?.completion_tokens ?? 0 };
}

async function callGemini(prompt: string, key: string, model: string): Promise<Raw> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA, thinkingConfig: { thinkingBudget: 0 } } })
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const b: any = await res.json();
    const content = b?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
    return { content, inTok: b?.usageMetadata?.promptTokenCount ?? 0, outTok: b?.usageMetadata?.candidatesTokenCount ?? 0 };
}

function callModel(m: Model, prompt: string, key: string): Promise<Raw> {
    if (m.kind === "gemini") return callGemini(prompt, key, m.model);
    if (m.kind === "openrouter") return callGroqLike("https://openrouter.ai/api/v1/chat/completions", prompt, key, m.model);
    return callGroqLike("https://api.groq.com/openai/v1/chat/completions", prompt, key, m.model);
}

// Tolerant parse → the one row's verdict as a printable string.
function verdict(content: string, id: string): string {
    let rows: any[] = [];
    try {
        const fence = content.trim().replace(/^```[a-z0-9]*\s*/i, "").replace(/\s*```$/, "");
        const p = JSON.parse(fence);
        rows = Array.isArray(p) ? p : Array.isArray(p?.translations) ? p.translations : [];
    } catch { return `⚠️ unparseable: ${content.slice(0, 120)}`; }
    const r = rows.find(x => String(x?.id) === id);
    if (!r) return "⚠️ no row for id";
    if (r.skip === true) return "[skip]";
    if (typeof r.text !== "string" || r.text.trim() === "") return "⚠️ empty text";
    return `${r.text}   ‹lang=${r.lang ?? "?"}›`;
}

// ---- Run ------------------------------------------------------------------
function loadCases(): Case[] {
    const here = dirname(fileURLToPath(import.meta.url));
    try {
        const extra = JSON.parse(readFileSync(join(here, "quality-cases.json"), "utf8"));
        if (Array.isArray(extra) && extra.length) { console.log(`(+${extra.length} custom cases from quality-cases.json)\n`); return [...DEFAULT_CASES, ...extra]; }
    } catch { /* no custom file — fine */ }
    return DEFAULT_CASES;
}

async function main() {
    const active = MODELS.filter(m => { const k = process.env[m.keyEnv]; if (!k) { console.log(`— skipping ${m.label} (${m.keyEnv} not set)`); return false; } return true; });
    if (!active.length) { console.error("\nNo keys set. Try: GEMINI_KEY=... GROQ_KEY=... npx tsx scripts/quality-ab.ts"); process.exit(1); }
    console.log(`\nRunning ${loadCases().length} cases × ${active.length} models\n${"=".repeat(72)}`);

    const totals = new Map<string, { in: number; out: number; ms: number; n: number }>();
    for (const c of loadCases()) {
        console.log(`\n▍ ${c.text}`);
        console.log(`  → target: ${c.target}${c.context ? `   (context: “${c.context.map(x => x.text).join(" / ")}”)` : ""}`);
        console.log(`  ⓘ ${c.note}`);
        console.log(`  ✓ expected: ${c.expect}`);
        const req: BatchRequest = { messages: [{ id: "1", author: c.author ?? "user", text: c.text }], context: c.context ?? [], targetLang: c.target };
        const prompt = buildPrompt(req);
        for (const m of active) {
            const key = process.env[m.keyEnv]!;
            const t0 = Date.now();
            try {
                const raw = await callModel(m, prompt, key);
                const ms = Date.now() - t0;
                const t = totals.get(m.label) ?? { in: 0, out: 0, ms: 0, n: 0 };
                t.in += raw.inTok; t.out += raw.outTok; t.ms += ms; t.n++; totals.set(m.label, t);
                console.log(`    ${m.label.padEnd(26)} ${verdict(raw.content, "1")}   (${ms}ms)`);
            } catch (e: any) {
                console.log(`    ${m.label.padEnd(26)} ❌ ${e.message}`);
            }
        }
    }

    // Rough cost extrapolation to 1,000 REAL batches (~8 msgs each). Single-msg
    // calls here over-weight the fixed prompt, so treat this as an upper bound.
    console.log(`\n${"=".repeat(72)}\nAvg latency & rough cost (per 1,000 eight-message batches, upper bound):`);
    for (const m of active) {
        const t = totals.get(m.label); if (!t || !t.n) continue;
        const avgIn = t.in / t.n, avgOut = t.out / t.n;
        const per1k = (avgIn * m.priceIn + avgOut * m.priceOut) / 1000; // $ per 1k single-msg calls
        console.log(`  ${m.label.padEnd(26)} ${Math.round(t.ms / t.n)}ms avg   ~${avgIn.toFixed(0)} in / ${avgOut.toFixed(0)} out tok   ~$${per1k.toFixed(2)}/1k`);
    }
    console.log("");
}
main();
