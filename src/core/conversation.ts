import { letter } from "../cli/render.js";
import type { Authorization, RequestBody } from "./types.js";

export interface ChatTurn { id: string; role: "assistant" | "user"; text: string }
export interface ChatCard { id: string; revision: number; body: RequestBody }
type Interpretation = { value?: string; custom?: string; authorization?: Authorization; followup?: "unsure" | "needs_clarification"; elsewhere?: true };
const unsure: Interpretation = { followup: "unsure" };
const clarify: Interpretation = { followup: "needs_clarification" };
const normalized = (s: string) => s.trim().toLowerCase();

function listed(scope: string): string[] {
  return scope.replace(/^(?:files|entries|items)\s+/i, "").split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map(s => s.trim()).filter(Boolean);
}

export function withinListedScope(scope: string, limit: string): boolean {
  if (scope === limit) return true;
  const offered = listed(limit);
  const wanted = listed(scope);
  const unit = /^(files|entries|items)\s+/i;
  const requestedUnit = unit.exec(scope)?.[1]?.toLowerCase();
  const offeredUnit = unit.exec(limit)?.[1]?.toLowerCase();
  return (!requestedUnit || !offeredUnit || requestedUnit === offeredUnit) && !!wanted.length
    && new Set(wanted).size === wanted.length && offered.every(x => /^[\w.-][\w./-]*$/.test(x)) && wanted.every(x => offered.includes(x));
}

/** An explicit subset keeps the offered action and target. Its effect must be reported for the subset. */
function scopedChoice(body: RequestBody, phrase: string): Interpretation {
  const candidates: Interpretation[] = [];
  for (const option of body.options ?? []) {
    const auth = option.authorization;
    if (!auth) continue;
    const action = normalized(auth.action);
    const gerund = action.replace(/e$/, "") + "ing";
    const match = [action, gerund].find(verb => normalized(phrase).startsWith(verb + " "));
    if (!match) continue;
    const scope = phrase.slice(match.length).trim().replace(/^only\s+/i, "");
    if (scope === auth.scope || scope === "those " + auth.target.replace(/\/$/, "")) {
      candidates.push({ value: option.id }); continue;
    }
    const offered = listed(auth.scope);
    const wanted = listed(scope);
    if (offered.length < 2 || !withinListedScope(scope, auth.scope)) continue;
    if (wanted.length === offered.length) candidates.push({ value: option.id });
    else {
      const units = /^(?:files|entries|items)\s+/i.exec(auth.scope)?.[0] ?? "";
      candidates.push({ value: option.id, custom: scope, authorization: { action: auth.action, target: auth.target, scope: units + wanted.join(", ") } });
    }
  }
  // Prefer a named option over a subset of a wider option when both express the same choice.
  const named = candidates.filter(c => !c.authorization);
  if (named.length === 1) return named[0]!;
  if (candidates.length === 1) return candidates[0]!;
  return clarify;
}

export function interpretChat(cards: ChatCard[], index: number, quote: string, bareAllowed: boolean, otherOpen: boolean): Interpretation {
  const target = cards[index]!;
  const aliases = (card: ChatCard, n: number) => [letter(n), card.body.id, card.id, card.id + "@" + card.revision]
    .filter((s): s is string => !!s).map(normalized);
  const parts = quote.trim().split(/;\s*|\n(?=[\w@-]+\s*:)/);
  let phrase = quote.trim();
  let named = false;
  if (parts.length > 1 || /^[\w@-]+\s*:/.test(phrase)) {
    const replies = new Map<number, string>();
    for (const part of parts) {
      const m = /^([\w@-]+)\s*:\s*([\s\S]+)$/.exec(part.trim());
      if (!m) return unsure;
      const found = cards.map((c, n) => aliases(c, n).includes(normalized(m[1]!)) ? n : -1).filter(n => n >= 0);
      if (found.length !== 1 || replies.has(found[0]!)) return unsure;
      if (otherOpen && ![cards[found[0]!]!.id, cards[found[0]!]!.id + "@" + cards[found[0]!]!.revision].includes(m[1]!)) return unsure;
      replies.set(found[0]!, m[2]!);
    }
    if (!replies.has(index)) return { ...unsure, elsewhere: true };
    phrase = replies.get(index)!; named = true;
  }
  if (/[?]/.test(phrase) || /^(what|why|how|when|where|which|could|can|does|will|would|is|are)\b/i.test(phrase)) return clarify;
  if (/\b(wait|unsure|not sure|hold on|maybe|actually)\b/i.test(phrase)) return unsure;
  const word = normalized(phrase).replace(/[.!]$/, "");
  const options = target.body.options ?? [];
  const yes = ["yes", "go", "approve"].includes(word);
  if (!named && (!bareAllowed || otherOpen) && (yes || cards.filter(c => c.body.kind !== "notice").length > 1 || otherOpen)) {
    if (!otherOpen && !yes) {
      const action = phrase.trim().replace(/^yes\s*,?\s+|^approve\s+/i, "").replace(/^approve\s+/i, "");
      const matching = cards.map(c => scopedChoice(c.body, action));
      if (matching[index]?.value && matching.filter(choice => choice.value).length === 1) return matching[index]!;
    }
    return unsure;
  }
  const matches = options.filter(o => [normalized(o.id), normalized(o.label)].includes(word));
  if (matches.length === 1) return { value: matches[0]!.id };
  if (yes) {
    const actions = options.filter(o => o.authorization);
    return actions.length === 1 ? { value: actions[0]!.id } : unsure;
  }
  if (["no", "decline"].includes(word)) {
    const decline = options.filter(o => !o.authorization);
    return decline.length === 1 && options.some(o => o.authorization) ? { value: decline[0]!.id } : unsure;
  }
  if (options.some(o => o.authorization)) {
    const actionText = phrase.trim().replace(/^(?:yes\s*[,;]\s*|yes\s+)/i, "").replace(/^approve\s+/i, "");
    return scopedChoice(target.body, actionText);
  }
  return { custom: phrase };
}

export function laterCorrection(turns: ChatTurn[], cards: ChatCard[], index: number, review: string): ChatTurn | undefined {
  let otherReview = false;
  for (const turn of turns) {
    if (turn.role === "assistant") {
      const next = /^## Review (V-[\w-]+):/m.exec(turn.text);
      if (next) otherReview = next[1] !== review;
      continue;
    }
    const text = turn.text.trim();
    const result = interpretChat(cards, index, text, true, false);
    if (result.elsewhere) continue;
    const addressed = /^[\w@-]+\s*:/.test(text);
    if (otherReview && !text.startsWith(cards[index]!.id)) continue;
    if (addressed || result.value || /\b(wait|stop|withdraw|hold on|correction|actually|instead|only|don't|do not|meant|changed my mind)\b/i.test(text)) return turn;
  }
  return undefined;
}
