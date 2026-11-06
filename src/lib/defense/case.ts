import { z } from "zod";
import { askJson as defaultAskJson, type AskOpts, type AskResult } from "@/lib/ai/gemini";
import type { EvidenceItem, EvidenceKind } from "@/lib/evidence/folder";

export type CaseDraft = {
  summary: string;
  timeline: { at: string; text: string; evidenceIds: string[] }[];
  argument: { text: string; evidenceIds: string[] }[];
  sellerNote: string;
};

export const caseDraftSchema: z.ZodType<CaseDraft> = z.object({
  summary: z.string(),
  timeline: z.array(z.object({ at: z.string(), text: z.string(), evidenceIds: z.array(z.string()) })),
  argument: z.array(z.object({ text: z.string(), evidenceIds: z.array(z.string()) })),
  sellerNote: z.string(),
});

// ---- Claim extraction ----

const MONTH_NAMES = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
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
  { re: new RegExp(String.raw`\b${MONTH_NAMES}[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "gi"), iso: (m) => `${m[3]}-${pad(monthNo(m[1]))}-${pad(m[2])}` },
  { re: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_NAMES}[a-z]*\.?,?\s+(\d{4})\b`, "gi"), iso: (m) => `${m[3]}-${pad(monthNo(m[2]))}-${pad(m[1])}` },
];
// Year-less forms are compared on month-day only.
const MD_RES: { re: RegExp; md: (m: RegExpMatchArray) => [number, number] }[] = [
  { re: new RegExp(String.raw`\b${MONTH_NAMES}[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "gi"), md: (m) => [monthNo(m[1]), Number(m[2])] },
  { re: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_NAMES}[a-z]*\b`, "gi"), md: (m) => [monthNo(m[2]), Number(m[1])] },
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
  problems.push(...checkText("sellerNote", draft.sellerNote, folder));
  return { ok: problems.length === 0, problems };
}

// ---- Deterministic template ----

const ordered = (folder: EvidenceItem[]) =>
  [...folder].sort((a, b) => (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at < b.at ? -1 : 1));

const line = (i: EvidenceItem) => `${i.title}: ${i.summary}${i.simulated ? " (simulated)" : ""}`;

/** Built only from folder items, so it passes validateClaims by construction. */
export function templateCase(folder: EvidenceItem[], requirements: { needed: EvidenceKind[] }): CaseDraft {
  const items = ordered(folder);
  const argument = requirements.needed.flatMap((kind) => {
    const of = items.filter((i) => i.kind === kind);
    return of.length ? [{ text: of.map(line).join(" "), evidenceIds: of.map((i) => i.id) }] : [];
  });
  return {
    summary: `This pack lists ${items.length} evidence item${items.length === 1 ? "" : "s"} from the order record, in time order, with the records that answer the buyer's claim.`,
    timeline: items.map((i) => ({ at: i.at ?? "", text: line(i), evidenceIds: [i.id] })),
    argument,
    sellerNote: "",
  };
}

// ---- Writer ----

type DisputeLike = { dispute_id: string; reason: string; dispute_amount: { currency_code: string; value: string } };
type WriteInput = {
  dispute: DisputeLike;
  folder: EvidenceItem[];
  requirements: { plain: string; needed: EvidenceKind[] };
};
type Ask = <T>(opts: AskOpts<T>) => Promise<AskResult<T>>;

const SYSTEM = `You write a dispute response for a small US PayPal seller. You may ONLY use facts from the evidence items listed in the user message.
Rules:
- Every timeline and argument entry must list the ids of the evidence items it relies on (evidenceIds), copied exactly.
- Never state an amount, date, tracking number or fact that is not in the cited items. If evidence is missing, say less, never invent.
- Items marked simulated=true come from a demo carrier or simulation: when you cite one, say "simulated".
- Plain, factual, polite tone. No legal claims. summary and sellerNote are short and may cite nothing, but must not contain amounts, dates or identifiers.
Return JSON: { summary, timeline: [{ at, text, evidenceIds }], argument: [{ text, evidenceIds }], sellerNote }.`;

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

export async function writeCase(
  input: WriteInput,
  deps: { askJson?: Ask } = {},
): Promise<{ draft: CaseDraft; usedFallback: boolean }> {
  const ask = deps.askJson ?? defaultAskJson;
  const fallback = () => ({ draft: templateCase(input.folder, input.requirements), usedFallback: true });
  const prompt = buildPrompt(input);

  let user = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ask({ system: SYSTEM, user, schema: caseDraftSchema, maxTokens: 2000 });
    if (!res.ok && res.reason !== "invalid") return fallback();
    if (res.ok) {
      const v = validateClaims(res.data, input.folder);
      if (v.ok) return { draft: res.data, usedFallback: false };
      user = `${prompt}\n\nYour previous draft was rejected. Fix every problem, using only the evidence above:\n- ${v.problems.join("\n- ")}`;
    } else {
      user = `${prompt}\n\nYour previous answer was not valid JSON of the required shape. Return exactly the requested JSON.`;
    }
  }
  return fallback();
}
