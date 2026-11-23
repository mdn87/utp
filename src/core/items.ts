import type { RequestBody } from "./types.js";

export interface ItemPrompt {
  id: string;
  label: string;
  choices: readonly string[];
  detailsFor: readonly string[];
  detailLabel?: string;
}

export function itemPrompts(body: RequestBody): ItemPrompt[] {
  if (body.kind === "handoff" && Array.isArray(body.steps)) {
    return body.steps.map((step) => ({
      id: step.id, label: step.command, choices: ["done", "blocked", "skipped"],
      detailsFor: ["done", "blocked"], detailLabel: "What did you observe?",
    }));
  }
  if (body.kind === "accept" && Array.isArray(body.goals)) {
    return body.goals.map((goal) => ({
      id: goal.id, label: goal.goal, choices: ["accepted", "partly", "not_accepted"], detailsFor: [],
    }));
  }
  if (body.kind === "assumptions" && Array.isArray(body.assumptions)) {
    return body.assumptions.map((item) => ({
      id: item.id, label: item.statement, choices: ["keep", "change"], detailsFor: ["change"], detailLabel: "Replacement text",
    }));
  }
  return [];
}

export function itemAnswerProblem(prompts: ItemPrompt[], items: Record<string, string> | undefined,
  details: Record<string, string> | undefined): string | undefined {
  const known = new Set(prompts.map((item) => item.id));
  const unknown = [...Object.keys(items ?? {}), ...Object.keys(details ?? {})].find((id) => !known.has(id));
  if (unknown) return `item ${unknown} is not on this card`;
  for (const prompt of prompts) {
    const value = items && Object.hasOwn(items, prompt.id) ? items[prompt.id] : undefined;
    if (!value || !prompt.choices.includes(value)) return `item ${prompt.id} needs one of ${prompt.choices.join(", ")}`;
    const detail = details && Object.hasOwn(details, prompt.id) ? details[prompt.id] : undefined;
    if (prompt.detailsFor.includes(value) && !detail?.trim()) return `item ${prompt.id} needs its result or replacement text`;
  }
  return undefined;
}
