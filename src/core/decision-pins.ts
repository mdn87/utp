import { reviewRequestsHash } from "./check.js";

export interface SavedPin {
  id: string;
  revision: number;
  review_id: string;
  title: string;
  answer: string;
  note?: string;
  pinned_at: string;
}

export function pinVersion(pin: SavedPin): string {
  return reviewRequestsHash([pin.id, pin.revision, pin.answer, pin.note, pin.pinned_at]);
}

export const PIN_CHANGES = {
  reversed: "Reversed", amended: "Amended", superseded: "Superseded", changed: "Answer changed", withdrawn: "Answer withdrawn",
  cancelled: "Cancelled", stale: "Basis changed", late_conflict: "Conflicting answer",
} as const;

export interface DecisionPin extends SavedPin {
  stale: boolean;
  reasons: (keyof typeof PIN_CHANGES)[];
}
