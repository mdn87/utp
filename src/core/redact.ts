import { isIP } from "node:net";
import type { DecisionLogEntry } from "./engine.js";

const REPLACEMENT = "[redacted]";
const PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp; check?: (match: string) => boolean }> = [
  { kind: "email address", pattern: /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi },
  { kind: "IP address", pattern: /(?<![\w:])(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]*(?<!\.)(?![\w:])/gi,
    check: (match) => isIP(match) === 6 },
  { kind: "IP address", pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    check: (match) => isIP(match) === 4 },
  { kind: "absolute path", pattern: /(["'])(?:[a-z]:[\\/]+|\\\\[\w.-]+[\\/]+|\/(?=[\w.-]))[^\r\n]*?\1/gi },
  { kind: "absolute path", pattern: /(?<![\w.:/\\])(?:[a-z]:[\\/]+|\\\\[\w.-]+[\\/]+|\/(?=[\w.-]))[^\s"'<>|]+/gi },
  { kind: "credential", pattern: /\b(?:utp_|gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-|AKIA)[a-z0-9_-]{12,}\b/gi },
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

function escapePattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function scrub(value: string, denyList: readonly string[]): { text: string; kinds: string[] } {
  const kinds = new Set<string>();
  let text = value;
  for (const entry of denyList) {
    text = text.replace(new RegExp(escapePattern(entry), "gi"), () => {
      kinds.add("private deny-list entry");
      return REPLACEMENT;
    });
  }
  for (const { kind, pattern, check } of PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (check && !check(match)) return match;
      kinds.add(kind);
      return REPLACEMENT;
    });
  }
  return { text, kinds: [...kinds] };
}

export function leakKinds(text: string, denyList: readonly string[] = []): string[] {
  const kinds = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const kind of scrub(value, denyList).kinds) kinds.add(kind);
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        scan(key);
        scan(item);
      }
    }
  };
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { value = text; }
  scan(value);
  return [...kinds];
}

/** Public exports use an allowlist. Raw quotes, evidence and project details never enter this format. */
export function redactedDecisions(entries: readonly DecisionLogEntry[], denyList: readonly string[]): string {
  const redact = (text: string): string => scrub(text, denyList).text;
  const decisions = entries.map((entry) => ({
    kind: entry.kind,
    question: redact(entry.question),
    status: entry.status,
    answer: entry.answer === null ? null : redact(entry.answer),
    reversals: entry.reversals.map((reversal) => ({ reason: redact(reversal.reason) })),
  }));
  return JSON.stringify({ utp_export: "1", decisions }, null, 2) + "\n";
}
