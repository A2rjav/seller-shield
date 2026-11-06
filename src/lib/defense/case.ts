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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number | string) => String(n).padStart(2, "0");

type Claims = { money: Set<number>; dates: Set<string>; tokens: Set<string> };

const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}/g;
const US_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
const NAMED_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
const TOKEN_RE = /\b[A-Z0-9]{10,}\b/g;

const toCents = (s: string) => Math.round(parseFloat(s.replace(/[$,\s]/g, "")) * 100);
const fullYear = (y: string) => (y.length === 2 ? `20${y}` : y);

function extract(text: string): Claims {
  const money = new Set<number>();
  const dates = new Set<string>();
  const tokens = new Set<string>();
  for (const m of text.match(MONEY_RE) ?? []) money.add(toCents(m));
  for (const m of text.match(ISO_RE) ?? []) dates.add(m);
  for (const m of text.matchAll(US_RE)) dates.add(`${fullYear(m[3])}-${pad(m[1])}-${pad(m[2])}`);
  for (const m of text.matchAll(NAMED_RE)) {
    dates.add(`${m[3]}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(m[2])}`);
  }
  for (const m of text.match(TOKEN_RE) ?? []) if (/\d/.test(m)) tokens.add(m);
  return { money, dates, tokens };
}

/** What a cited item "contains": its title, summary and JSON data, with money also read from bare decimals/cents. */
function haystack(items: EvidenceItem[]): { text: string; claims: Claims } {
  const text = items.map((i) => `${i.title}\n${i.summary}\n${JSON.stringify(i.data) ?? ""}`).join("\n");
  const claims = extract(text);
  for (const m of text.matchAll(/(?<![\d.])(\d[\d,]*)\.(\d{2})(?!\d)/g)) claims.money.add(toCents(`${m[1]}.${m[2]}`));
  for (const m of text.matchAll(/(?<![\d.$])(\d{3,9})(?![\d.])/g)) claims.money.add(Number(m[1])); // integer cents in data
  return { text, claims };
}

function checkText(label: string, text: string, items: EvidenceItem[]): string[] {
  const { text: hay, claims: have } = haystack(items);
  const want = extract(text);
  const problems: string[] = [];
  for (const c of want.money) if (!have.money.has(c)) problems.push(`${label}: amount $${(c / 100).toFixed(2)} is not in the cited evidence`);
  for (const d of want.dates) if (!have.dates.has(d)) problems.push(`${label}: date ${d} is not in the cited evidence`);
  for (const t of want.tokens) if (!hay.includes(t)) problems.push(`${label}: identifier ${t} is not in the cited evidence`);
  return problems;
}

/** Rejects any entry without existing evidence ids and any money, date or tracking-like token the cited items do not contain. */
export function validateClaims(draft: CaseDraft, folder: EvidenceItem[]): { ok: boolean; problems: string[] } {
  const byId = new Map(folder.map((i) => [i.id, i]));
  const problems: string[] = [];

  const entries = [
    ...draft.timeline.map((e, i) => ({ label: `timeline[${i}]`, text: e.text, ids: e.evidenceIds })),
    ...draft.argument.map((e, i) => ({ label: `argument[${i}]`, text: e.text, ids: e.evidenceIds })),
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

function buildPrompt(input: WriteInput): string {
  const have = new Set(input.folder.map((i) => i.kind));
  const present = input.requirements.needed.filter((k) => have.has(k));
  const missing = input.requirements.needed.filter((k) => !have.has(k));
  const rows = ordered(input.folder).map((i) => `${i.id} | ${i.kind} | ${i.at ?? "undated"} | ${i.summary} | ${i.simulated}`);
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
