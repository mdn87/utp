// Shapes shared by the engine, the service, and the client.

export const KINDS = ["choose", "approve", "handoff", "clarify", "accept", "assumptions", "notice"] as const;
export type Kind = (typeof KINDS)[number];

export interface Authorization {
  action: string;
  target: string;
  scope: string;
  expected_effect?: string;
}

export interface OptionSpec {
  id: string;
  label: string;
  consequence: string;
  authorization?: Authorization;
}

export interface EvidenceItem {
  claim: string;
  kind: string;
  source: string;
  date: string;
}

export interface HandoffStep {
  id: string;
  actor: string;
  machine: string;
  shell: string;
  command: string;
  expected_result: string;
  tested: boolean;
  why_person: string;
}

export interface AcceptanceGoal {
  id: string;
  goal: string;
  coverage: "covered" | "partly_covered" | "not_covered";
  evidence: EvidenceItem[];
}

export interface AssumptionItem {
  id: string;
  statement: string;
  consequence: string;
}

export type RequestPreview = { label: string } & (
  { text: string }
  | { media_type: "image/png" | "image/jpeg" | "image/webp"; data: string }
);

export interface DefaultEligibility {
  local: true;
  scope_delta: "none";
  undo: string;
  authority: string;
  size: "small" | "larger-technical";
  panel?: { requested_by_person: true; finding: string };
}

export interface DefaultNotice {
  request_id: string;
  revision: number;
  question: string;
  option: string;
  conflict: boolean;
}

export interface RequestBody {
  kind: Kind;
  category?: string;
  question: string;
  why_now: string;
  options?: OptionSpec[];
  recommendation?: { option: string; because: string; preserves?: string; bolder_alternative?: string };
  default?: { option: string; consequence: string; eligibility?: DefaultEligibility };
  glossary?: Record<string, string>;
  evidence?: EvidenceItem[];
  steps?: HandoffStep[];
  goals?: AcceptanceGoal[];
  assumptions?: AssumptionItem[];
  previews?: RequestPreview[];
  stakes: { reversibility: "easy" | "costly" | "one_way" };
  level: 0 | 1 | 2 | 3;
  level_reason: string;
  tags?: string[];
  related?: string[];
  dedupe_key?: string;
  depends_on?: string[];
  basis?: { files?: string[] };
  expires_at?: string;
  origin?: { agent?: string; platform?: string; session?: string };
  notes?: string;
}

/** How sure UTP is that an answer came from the person. */
export type Verified = "channel" | "transcript" | "none";

export type Disposition = "answered_elsewhere" | "no_longer_matters";

export interface AnswerRecord {
  value: string | null;
  custom?: string;
  items?: Record<string, string>;
  details?: Record<string, string>;
  disposition?: Disposition;
  sureness?: "sure" | "leaning" | "unsure";
  feedback?: string;
  note?: string;
  /** The person's words, quoted verbatim, when the answer came from the conversation. */
  quote?: string;
  /** The reply named the card or the action, so it can't land on the wrong card. */
  addressed?: boolean;
  channel: string;
  verified: Verified;
  machine: string;
  session: string;
  at: string;
}

export type GrantStatus = "active" | "used" | "done" | "revoked" | "expired" | "released" | "taken_over";

export interface Grant {
  id: string;
  request_id: string;
  revision: number;
  owner: Actor;
  epoch: number;
  issued_at: string;
  lease_until: string;
  from_default: boolean;
  option: string;
  authorization: Authorization;
  provenance: Verified;
  status: GrantStatus;
  used_at?: string;
}

export interface Actor {
  machine: string;
  session: string;
}

/** Exit codes, from docs/concept/lifecycle.md ("Command-line contract"). */
export const EXIT = {
  OK: 0,
  WAITING: 10,
  STALE: 11,
  CANCELLED: 12,
  EXPIRED: 13,
  LATE_CONFLICT: 14,
  DEFAULT_CLAIMED: 15,
  ANSWER_FIRST: 16,
  REVOKED: 17,
  PROVENANCE: 18,
  NOT_ALLOWED: 19,
  CHECK_FAILED: 20,
  BUSY: 30,
  EPOCH: 31,
  UNREACHABLE: 32,
  NOT_FOUND: 40,
  OTHER: 1,
} as const;

export interface OpResult {
  code: number;
  message?: string;
  [key: string]: unknown;
}
