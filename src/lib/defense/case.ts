import { z } from "zod";
import { askJson as defaultAskJson, type AskOpts, type AskResult } from "@/lib/ai/gemini";
import type { EvidenceItem, EvidenceKind } from "@/lib/evidence/folder";
import { evidenceKindLabel } from "@/lib/dashboard/view";
import { CITATION_CLAIM } from "./notes";

export { CITATION_CLAIM, NOTES_MAX, caseNotes } from "./notes";

/** What the model writes: only cited entries. */
export type CaseBody = {
  timeline: { at: string; text: string; evidenceIds: string[] }[];
  argument: { text: string; evidenceIds: string[] }[];
};

/** A stored case: the model's cited entries plus a summary built in code (never AI free text). */
export type CaseDraft = CaseBody & { summary: string };

export const caseBodySchema: z.ZodType<CaseBody> = z.object({
  timeline: z.array(z.object({ at: z.string(), text: z.string(), evidenceIds: z.array(z.string()) })),
  argument: z.array(z.object({ text: z.string(), evidenceIds: z.array(z.string()) })),
});

// ---- Claim extraction ----

// Full month names or standard abbreviations only (never "any word starting with mar/dec/..."), so ordinary
// words ("marked 2", "decided 3", "separate 4") are not read as dates. "May" is also an ordinary word, so
// capitalised "May" always counts, and lowercase "may" only when the surrounding text reads as a date.
// Case-insensitivity is spelled out per letter (no `i` flag) because "May" must stay case-sensitive.
const ci = (src: string) => src.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const OTHER_MONTHS = ci("Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?");
/** Month before the day: "Nov 12", "May 5, 2026", "may 5th". */
const MONTH_FIRST = String.raw`(${OTHER_MONTHS}|May|MAY|may(?=\s+\d{1,2}(?:st|nd|rd|th|\s*,|\s+\d{4}\b)))\b\.?`;
/** Month after the day: "12 Nov", "5 May 2026". */
const MONTH_AFTER = String.raw`(${OTHER_MONTHS}|May|MAY|may(?=,?\s+\d{4}\b))\b\.?`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number | string) => String(n).padStart(2, "0");
const monthNo = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const fullYear = (y: string) => (y.length === 2 ? `20${y}` : y);
const validMD = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

const NUM = String.raw`\d[\d,]*(?:\.\d{1,2})?`;
const MONEY_RES = [
  new RegExp(String.raw`\$\s?(${NUM})`, "g"),
  new RegExp(String.raw`(?<![\d.,])(${NUM})\s*(?:USD|dollars?)\b`, "gi"),
  new RegExp(String.raw`\bUSD\s?(${NUM})`, "g"),
];
const toCents = (s: string) => Math.round(parseFloat(s.replace(/,/g, "")) * 100);

const FULL_RES: { re: RegExp; iso: (m: RegExpMatchArray) => string }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})/g, iso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/g, iso: (m) => `${m[1]}-${pad(m[2])}-${pad(m[3])}` },
  { re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, iso: (m) => `${fullYear(m[3])}-${pad(m[1])}-${pad(m[2])}` },
  { re: new RegExp(String.raw`\b${MONTH_FIRST}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "g"), iso: (m) => `${m[3]}-${pad(monthNo(m[1]))}-${pad(m[2])}` },
  { re: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_AFTER},?\s+(\d{4})\b`, "g"), iso: (m) => `${m[3]}-${pad(monthNo(m[2]))}-${pad(m[1])}` },
];
// Year-less forms are compared on month-day only.
const MD_RES: { re: RegExp; md: (m: RegExpMatchArray) => [number, number] }[] = [
  { re: new RegExp(String.raw`\b${MONTH_FIRST}\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g"), md: (m) => [monthNo(m[1]), Number(m[2])] },
  { re: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_AFTER}`, "g"), md: (m) => [monthNo(m[2]), Number(m[1])] },
  { re: /(?<![\d/.:-])(\d{1,2})\/(\d{1,2})(?![\d/])/g, md: (m) => [Number(m[1]), Number(m[2])] },
];
const TOKEN_RE = /\b[A-Za-z0-9]{10,}\b/g;

/** Joins digit groups separated by single spaces or dashes ("9400 1118 9922") so they match as one number. */
const collapse = (t: string) => t.replace(/\b\d{4,}(?:[ -]\d{4,})+\b/g, (g) => g.replace(/[ -]/g, ""));

type Claims = { money: Set<number>; dates: Set<string>; md: Set<string>; tokens: Set<string> };

function extract(text: string): Claims {
  const money = new Set<number>();
  const dates = new Set<string>();
  const md = new Set<string>();
  const tokens = new Set<string>();
  for (const re of MONEY_RES) for (const m of text.matchAll(re)) money.add(toCents(m[1]));
  let rest = text;
  for (const { re, iso } of FULL_RES) {
    for (const m of text.matchAll(re)) dates.add(iso(m));
    rest = rest.replace(re, " ");
  }
  for (const { re, md: f } of MD_RES) {
    for (const m of rest.matchAll(re)) {
      const [mo, d] = f(m);
      if (validMD(mo, d)) md.add(`${pad(mo)}-${pad(d)}`);
    }
  }
  for (const m of collapse(text).match(TOKEN_RE) ?? []) if (/\d/.test(m)) tokens.add(m.toLowerCase());
  return { money, dates, md, tokens };
}

const DECIMAL = /^\d+(?:\.\d{1,2})?$/;

/** Amounts a data object states, found structurally: *Cents keys as cents, amount-like keys as decimal dollars. */
function walkAmounts(v: unknown, out: Set<number>, key = "", depth = 0): void {
  if (depth > 8 || v === null || v === undefined) return;
  if (Array.isArray(v)) return v.forEach((x) => walkAmounts(x, out, key, depth + 1));
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walkAmounts(x, out, k, depth + 1);
    return;
  }
  if (/cents$/i.test(key) && typeof v === "number" && Number.isFinite(v)) out.add(Math.round(v));
  else if (/amount$|^value$/i.test(key) && (typeof v === "string" || typeof v === "number") && DECIMAL.test(String(v))) {
    out.add(toCents(String(v)));
  }
}

/** What cited items contain. Amounts come from "$x.yy"/"x.yy USD" in text and from structured data keys, never from digit runs. */
function haystack(items: EvidenceItem[]) {
  const text = items.map((i) => `${i.title}\n${i.summary}\n${JSON.stringify(i.data) ?? ""}`).join("\n");
  const prose = items.map((i) => `${i.title}\n${i.summary}`).join("\n");
  const claims = extract(text);
  claims.money = extract(prose).money;
  for (const i of items) walkAmounts(i.data, claims.money);
  for (const i of items) if (i.at) claims.dates.add(i.at.slice(0, 10));
  for (const d of claims.dates) claims.md.add(d.slice(5));
  return { text: collapse(text).toLowerCase(), claims };
}

function checkText(label: string, text: string, items: EvidenceItem[]): string[] {
  const { text: hay, claims: have } = haystack(items);
  const want = extract(text);
  const problems: string[] = [];
  for (const c of want.money) if (!have.money.has(c)) problems.push(`${label}: amount $${(c / 100).toFixed(2)} is not in the cited evidence`);
  for (const d of want.dates) if (!have.dates.has(d)) problems.push(`${label}: date ${d} is not in the cited evidence`);
  for (const d of want.md) if (!have.md.has(d)) problems.push(`${label}: date ${d} (month-day) is not in the cited evidence`);
  for (const t of want.tokens) if (!hay.includes(t)) problems.push(`${label}: identifier ${t} is not in the cited evidence`);
  return problems;
}

/** `at` must be empty or a date matching the date of one of the entry's cited items. */
function checkAt(label: string, at: string, items: EvidenceItem[]): string[] {
  if (!at.trim()) return [];
  const dates = extract(at).dates;
  if (dates.size === 0) return [`${label}: "at" must be empty or a date`];
  const allowed = new Set(items.flatMap((i) => (i.at ? [i.at.slice(0, 10)] : [])));
  return [...dates].filter((d) => !allowed.has(d)).map((d) => `${label}: "at" date ${d} does not match any cited item`);
}

/** Rejects any entry without existing evidence ids and any money, date or tracking-like token the cited items do not contain. */
export function validateClaims(draft: CaseDraft, folder: EvidenceItem[]): { ok: boolean; problems: string[] } {
  const byId = new Map(folder.map((i) => [i.id, i]));
  const problems: string[] = [];

  const entries = [
    ...draft.timeline.map((e, i) => ({ label: `timeline[${i}]`, text: e.text, ids: e.evidenceIds, at: e.at as string | null })),
    ...draft.argument.map((e, i) => ({ label: `argument[${i}]`, text: e.text, ids: e.evidenceIds, at: null as string | null })),
  ];
  for (const e of entries) {
    if (e.ids.length === 0) problems.push(`${e.label}: cites no evidence`);
    const known: EvidenceItem[] = [];
    for (const id of e.ids) {
      const it = byId.get(id);
      if (it) known.push(it);
      else problems.push(`${e.label}: unknown evidence id ${id}`);
    }
    problems.push(...checkText(e.label, e.text, known));
    if (e.at !== null) problems.push(...checkAt(e.label, e.at, known));
  }
  problems.push(...checkText("summary", draft.summary, folder));
  return { ok: problems.length === 0, problems };
}

// ---- Deterministic summary and notes ----

type Requirements = { plain: string; needed: EvidenceKind[] };

/** "The buyer says the order never arrived, so you need ..." -> "The buyer says the order never arrived." */
function claimSentence(plain: string): string {
  const m = plain.match(/^(.*?)(?:,\s*so\b|;)/);
  const s = (m ? m[1] : plain).trim().replace(/[.\s]+$/, "");
  return `${s}.`;
}

const kindList = (kinds: EvidenceKind[]) => (kinds.length ? kinds.map((k) => evidenceKindLabel(k).toLowerCase()).join(", ") : "none");

/** Built in code from the reason, the evidence coverage and counts. No AI text, no amounts, dates or ids. */
export function caseSummary(folder: EvidenceItem[], requirements: Requirements): string {
  const have = new Set(folder.map((i) => i.kind));
  const present = requirements.needed.filter((k) => have.has(k));
  const missing = requirements.needed.filter((k) => !have.has(k));
  const n = folder.length;
  const sim = folder.filter((i) => i.simulated).length;
  return [
    claimSentence(requirements.plain),
    `This response is built from ${n} evidence item${n === 1 ? "" : "s"}${sim ? ` (${sim} simulated)` : ""}.`,
    `Evidence this claim needs that is on file: ${kindList(present)}. Missing: ${kindList(missing)}.`,
    `${CITATION_CLAIM}.`,
  ].join(" ");
}

// ---- Deterministic template ----

const ordered = (folder: EvidenceItem[]) =>
  [...folder].sort((a, b) => (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at < b.at ? -1 : 1));

const line = (i: EvidenceItem) => `${i.title}: ${i.summary}${i.simulated ? " (simulated)" : ""}`;

/** Built only from folder items, so it passes validateClaims by construction. */
export function templateCase(folder: EvidenceItem[], requirements: Requirements): CaseDraft {
  const items = ordered(folder);
  const argument = requirements.needed.flatMap((kind) => {
    const of = items.filter((i) => i.kind === kind);
    return of.length ? [{ text: of.map(line).join(" "), evidenceIds: of.map((i) => i.id) }] : [];
  });
  return {
    summary: caseSummary(folder, requirements),
    timeline: items.map((i) => ({ at: i.at ?? "", text: line(i), evidenceIds: [i.id] })),
    argument,
  };
}

// ---- Writer ----

type DisputeLike = { dispute_id: string; reason: string; dispute_amount: { currency_code: string; value: string } };
type WriteInput = {
  dispute: DisputeLike;
  folder: EvidenceItem[];
  requirements: Requirements;
};
type Ask = <T>(opts: AskOpts<T>) => Promise<AskResult<T>>;

const SYSTEM = `You write a dispute response for a small US PayPal seller. You may ONLY use facts from the evidence items listed in the user message.
Rules:
- Every timeline and argument entry must list the ids of the evidence items it relies on (evidenceIds), copied exactly.
- Never state an amount, date, tracking number or fact that is not in the cited items. If evidence is missing, say less, never invent.
- Items marked simulated=true come from a demo carrier or simulation: when you cite one, say "simulated".
- Plain, factual, polite tone. No legal claims. Write no other text: no summary and no notes outside the entries.
Return JSON: { timeline: [{ at, text, evidenceIds }], argument: [{ text, evidenceIds }] }.`;

/** Buyer contact details never go to the model. */
const redactEmails = (t: string) => t.replace(/[^\s@<>"',;|]+@[^\s@<>"',;|]+\.[A-Za-z]{2,}/g, "[buyer email]");

function buildPrompt(input: WriteInput): string {
  const have = new Set(input.folder.map((i) => i.kind));
  const present = input.requirements.needed.filter((k) => have.has(k));
  const missing = input.requirements.needed.filter((k) => !have.has(k));
  const rows = ordered(input.folder).map((i) => redactEmails(`${i.id} | ${i.kind} | ${i.at ?? "undated"} | ${i.summary} | ${i.simulated}`));
  return [
    `Dispute reason: ${input.requirements.plain}`,
    `Evidence coverage: have [${present.join(", ")}]; missing [${missing.join(", ")}].`,
    `Evidence items (id | kind | at | summary | simulated):`,
    ...rows,
  ].join("\n");
}

export const CASE_MAX_TOKENS = 4096;

export async function writeCase(
  input: WriteInput,
  deps: { askJson?: Ask } = {},
): Promise<{ draft: CaseDraft; usedFallback: boolean }> {
  const ask = deps.askJson ?? defaultAskJson;
  const fallback = () => ({ draft: templateCase(input.folder, input.requirements), usedFallback: true });
  const prompt = buildPrompt(input);
  const summary = caseSummary(input.folder, input.requirements);

  let user = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ask({ system: SYSTEM, user, schema: caseBodySchema, maxTokens: CASE_MAX_TOKENS, tier: "quality" });
    if (!res.ok && res.reason !== "invalid") return fallback();
    if (res.ok) {
      // Only the cited entries are taken from the model; anything else it returns is dropped.
      const draft: CaseDraft = { summary, timeline: res.data.timeline, argument: res.data.argument };
      const v = validateClaims(draft, input.folder);
      if (v.ok) return { draft, usedFallback: false };
      user = `${prompt}\n\nYour previous draft was rejected. Fix every problem, using only the evidence above:\n- ${v.problems.join("\n- ")}`;
    } else {
      user = `${prompt}\n\nYour previous answer was not valid JSON of the required shape. Return exactly the requested JSON.`;
    }
  }
  return fallback();
}
