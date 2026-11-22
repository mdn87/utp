// The request engine for one project (docs/concept/lifecycle.md).
//
// Current state is a projection of the event log. load() replays the log
// through apply(), and every live operation commits one event and then runs
// the same apply(), so replayed and live state can't drift apart. Every state
// change goes through move(), which checks the transition table.
//
// Request bodies are stored as content-addressed payloads; answers, grants
// and evidence are small and travel inside their event.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { checkRequest } from "./check.js";
import { assertTransition, canTransition, TERMINAL, TransitionError, type State } from "./states.js";
import { CorruptStoreError, type EventStore, type StoredEvent } from "./store.js";
import {
  EXIT, type Actor, type AnswerRecord, type Authorization, type DefaultNotice, type Disposition, type Grant, type OpResult,
  type RequestBody, type Verified,
} from "./types.js";

export const GRANT_LEASE_MS = 24 * 60 * 60 * 1000;
export const TAKEOVER_IDLE_MS = 15 * 60 * 1000;
export const OUTCOMES = ["completed", "not-performed", "partial", "different", "unknown"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The channels an agent doesn't control. Everything else is recorded as unverified. */
const PERSON_CHANNELS: Readonly<Record<string, Verified>> = { "terminal-review": "channel" };

export class UsageError extends Error {}

type Args = Record<string, unknown>;
type Basis = Record<string, string>;

export interface Rev {
  key: string;
  id: string;
  revision: number;
  body: RequestBody;
  body_sha: string;
  status: State;
  hide_until?: string;
  basis: Basis;
  expected_basis: Basis;
  review_id: string;
  asked_at: string;
  presented_at?: string;
  answer?: AnswerRecord;
  answer_count: number;
  grants: string[];
  flags: string[];
  remaining_scope?: string;
  recovery_authorization?: Authorization;
  default_application?: { grant: string; basis: Basis };
  default_resolution?: "keep" | "redo";
  default_notice_pending?: boolean;
  reconciliations: { at: string; outcome: string; grant: string }[];
}

export interface Req {
  id: string;
  current: number;
  owner: Actor;
  epoch: number;
  observers: Actor[];
  reversals: { at: string; reason: string; tags: string[] }[];
}

export interface Review {
  id: string;
  status: "open" | "prepared";
  items: string[];
  presentations: { id: string; channel: string; at: string }[];
  default_notices?: DefaultNotice[];
}

export interface DecisionLogEntry {
  id: string;
  revision: number;
  kind: RequestBody["kind"];
  level: RequestBody["level"];
  question: string;
  status: State;
  answer: string | null;
  tags: string[];
  related: string[];
  reversals: Req["reversals"];
  asked_at: string;
  origin_project?: string;
  archived?: true;
}

interface SearchableDecision {
  entry: DecisionLogEntry;
  searchText: string;
}

interface DecisionArchive {
  origin: string;
  sequence: number;
  decisions: SearchableDecision[];
}

const SYSTEM: Actor = { machine: "service", session: "sweep" };
const key = (id: string, revision: number) => `${id}@${revision}`;
const sameActor = (a: Actor, b: Actor) => a.machine === b.machine && a.session === b.session;
const newId = (prefix: string, at: string) =>
  `${prefix}-${at.slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const notFound = (ref: unknown): OpResult => ({
  code: EXIT.NOT_FOUND, message: `nothing named ${String(ref)} in this project`,
});

function str(a: Args, name: string): string {
  const v = a[name];
  if (typeof v !== "string" || v.trim() === "") throw new UsageError(`${name} is required`);
  return v;
}

function optStr(a: Args, name: string): string | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new UsageError(`${name} must be text`);
  return v;
}

function basisArg(v: unknown): Basis | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new UsageError("basis must map each path to its fingerprint");
  for (const [p, s] of Object.entries(v)) {
    if (typeof s !== "string") throw new UsageError(`the fingerprint for ${p} must be text`);
  }
  return v as Basis;
}

function contentKey(body: RequestBody, basis: Basis): string {
  const sorted = (o: object | undefined) => (o ? Object.entries(o).sort(([a], [b]) => a.localeCompare(b)) : null);
  return JSON.stringify({
    kind: body.kind,
    question: normalize(body.question),
    options: (body.options ?? []).map((o) => [o.id, normalize(o.label), normalize(o.consequence), sorted(o.authorization)]),
    default: sorted(body.default),
    basis: sorted(basis),
  });
}

function strongProvenance(a: AnswerRecord): boolean {
  return a.verified === "channel" || (a.verified === "transcript" && a.addressed === true);
}

function sameTarget(a: Authorization, b: Authorization): boolean {
  return a.action === b.action && a.target === b.target;
}

function sameAuthorization(a: Authorization, b: Authorization): boolean {
  return sameTarget(a, b) && a.scope === b.scope;
}

function eligibleDefault(body: RequestBody): { option: string; authorization: Authorization } | undefined {
  const declared = body.default;
  const eligibility = declared?.eligibility;
  const text = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  if (!declared || !eligibility || body.level !== 2 || body.stakes.reversibility !== "easy"
      || (body.kind !== "choose" && body.kind !== "clarify")
      || !["approach", "priority", "process"].includes(body.category ?? "")
      || eligibility.local !== true || eligibility.scope_delta !== "none"
      || !text(eligibility.undo) || !text(eligibility.authority)) return undefined;
  if (eligibility.size !== "small" && (eligibility.size !== "larger-technical"
      || eligibility.panel?.requested_by_person !== true || !text(eligibility.panel.finding))) return undefined;
  const authorization = body.options?.find((option) => option.id === declared.option)?.authorization;
  return authorization ? { option: declared.option, authorization } : undefined;
}

function contradictsDefault(answer: AnswerRecord | undefined, option: string): boolean {
  return !!answer && !answer.disposition && answer.value !== option;
}

export class Engine {
  /** Emits "commit" after each committed event; the service uses it to wake waiters. */
  readonly events = new EventEmitter().setMaxListeners(0);
  private readonly reqs = new Map<string, Req>();
  private readonly revs = new Map<string, Rev>();
  private readonly reviews = new Map<string, Review>();
  private readonly grants = new Map<string, Grant>();
  private readonly archives = new Map<string, DecisionArchive>();
  private openReviewId: string | undefined;

  constructor(
    private readonly store: EventStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Rebuilds the projection from the log. Call once, after store.open(). */
  load(): void {
    for (const e of this.store.all()) this.apply(e);
  }

  /** Snapshots the source and its prior archives without exposing them to write operations. */
  relinkFrom(source: Engine, from: string, to: string, actor: Actor, opId?: string): OpResult {
    const previous = opId ? this.store.findOp(opId) : undefined;
    if (previous) {
      if (previous.data.op === "project.relink" && previous.data.from === from) return previous.result as OpResult;
      return { code: EXIT.OTHER, message: `operation id ${opId} was already used for a different operation` };
    }
    source.sweep();
    this.sweep();
    for (const [id, engine] of [[from, source], [to, this]] as const) {
      if (engine.hasRelinkWork()) {
        return { code: EXIT.NOT_ALLOWED, project: id, message: `Project ${id} has open requests or grants; finish them before relinking.` };
      }
    }

    const inherited = [...source.archives.values(), {
      origin: from, sequence: source.store.all().length, decisions: source.logEntries(),
    }];
    const archives = inherited.filter((archive) =>
      archive.origin !== to && archive.sequence > (this.archives.get(archive.origin)?.sequence ?? -1));
    const result = { code: EXIT.OK, project: to };
    if (!opId && archives.length === 0) return result;
    return this.commit("project.relink", "project.archived", actor, { from }, result, opId, { archives });
  }

  run(op: string, args: Args, actor: Actor, opId?: string): OpResult {
    try {
      if (opId) {
        const done = this.store.findOp(opId);
        if (done) {
          if (done.data.op !== op) {
            return { code: EXIT.OTHER, message: `operation id ${opId} was already used for ${String(done.data.op)}` };
          }
          return done.result as OpResult;
        }
      }
      this.sweep();
      switch (op) {
        case "ask": return this.ask(args, actor, opId);
        case "flush": return this.flush(actor, opId);
        case "presented": return this.presented(args, actor, opId);
        case "answer": return this.answer(args, actor, opId);
        case "wait": return this.wait(args, actor, opId);
        case "claim-default": return this.claimDefault(args, actor, opId);
        case "resolve-late": return this.resolveLate(args, actor, opId);
        case "begin": return this.begin(args, actor, opId);
        case "applied": return this.applied(args, actor, opId);
        case "reconcile": return this.reconcile(args, actor, opId);
        case "revise": return this.revise(args, actor, opId);
        case "cancel": return this.cancel(args, actor, opId);
        case "release": return this.release(args, actor, opId);
        case "takeover": return this.takeover(args, actor, opId);
        case "reverse": return this.reverse(args, actor, opId);
        case "show": return this.show(args);
        case "status": return this.status();
        case "log": return this.log(args);
        default: return { code: EXIT.OTHER, message: `unknown operation: ${op}` };
      }
    } catch (e) {
      if (e instanceof UsageError) return { code: EXIT.OTHER, message: e.message };
      if (e instanceof TransitionError) return { code: EXIT.NOT_ALLOWED, message: e.message };
      throw e;
    }
  }

  // ---- operations -------------------------------------------------------

  private ask(a: Args, actor: Actor, opId?: string): OpResult {
    const body = a.body as RequestBody;
    const failures = checkRequest(body);
    if (failures.length) return { code: EXIT.CHECK_FAILED, failures };
    const basis = this.basisFor(body, basisArg(a.basis));
    let near: string | undefined;
    if (body.dedupe_key) {
      const ck = contentKey(body, basis);
      for (const req of this.reqs.values()) {
        const rev = this.current(req);
        if (rev.body.dedupe_key !== body.dedupe_key || !this.isOpen(rev)) continue;
        if (contentKey(rev.body, rev.basis) !== ck) {
          near = req.id;
          continue;
        }
        const result = { code: EXIT.OK, id: req.id, revision: rev.revision, review_id: rev.review_id, attached: true };
        if (sameActor(req.owner, actor)) return { ...result, role: "owner" };
        if (req.observers.some((o) => sameActor(o, actor))) return { ...result, role: "observer" };
        return this.commit("ask", "request.attached", actor, { id: req.id, observer: actor }, { ...result, role: "observer" }, opId);
      }
    }
    const at = this.now().toISOString();
    const id = newId("R", at);
    const review_id = this.openReviewId ?? newId("V", at);
    const result = {
      code: EXIT.OK, id, revision: 1, review_id, role: "owner", attached: false,
      ...(near ? { near_duplicate: near } : {}),
    };
    return this.commit("ask", "request.asked", actor, { id, revision: 1, basis, review_id, owner: actor }, result, opId, { body });
  }

  private flush(actor: Actor, opId?: string): OpResult {
    const review = this.openReviewId ? this.reviews.get(this.openReviewId) : undefined;
    const items = review ? review.items.filter((k) => this.revs.get(k)?.status === "queued") : [];
    if (!review || items.length === 0) return { code: EXIT.OK, review_id: null, items: [], message: "nothing is queued" };
    const defaults = [...this.revs.values()].flatMap((rev): DefaultNotice[] => {
      if (!rev.default_notice_pending || !rev.default_application) return [];
      const grant = this.mustGrant(rev.default_application.grant);
      return [{ request_id: rev.id, revision: rev.revision, question: rev.body.question,
        option: grant.option, conflict: rev.status === "late_conflict" }];
    });
    return this.commit("flush", "review.flushed", actor, { review_id: review.id, default_notices: defaults },
      { code: EXIT.OK, review_id: review.id, items }, opId);
  }

  private presented(a: Args, actor: Actor, opId?: string): OpResult {
    const review = this.reviews.get(str(a, "review"));
    if (!review) return notFound(a.review);
    if (review.status !== "prepared") {
      return { code: EXIT.NOT_ALLOWED, message: "this review hasn't been prepared; run utp flush first" };
    }
    const channel = str(a, "channel");
    const at = this.now().toISOString();
    const presentation_id = newId("P", at);
    const items = review.items.filter((k) => {
      const r = this.revs.get(k);
      return r !== undefined && this.isCurrentRev(r) && this.isOpen(r);
    });
    return this.commit("presented", "review.presented", actor, { review_id: review.id, presentation_id, channel },
      { code: EXIT.OK, review_id: review.id, presentation_id, items }, opId);
  }

  private answer(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    const req = this.reqOf(rev);
    if (rev.revision !== req.current) return this.replaced(rev, req);
    const at = this.now().toISOString();
    const st = this.effective(rev, at);
    const closed = this.closedResult(st);
    if (closed) return closed;
    if (st === "queued" || st === "draft") {
      return { code: EXIT.NOT_ALLOWED, message: "this request hasn't been presented to the person yet, so an answer can't be bound to it" };
    }
    if (rev.body.kind === "notice") return { code: EXIT.NOT_ALLOWED, message: "notices need no answer" };
    const ref = { id: rev.id, revision: rev.revision };
    if (a.withdraw === true) {
      if (!rev.answer) return { code: EXIT.NOT_ALLOWED, message: "there is no answer to withdraw" };
      return this.commit("answer", "answer.withdrawn", actor, ref, { code: EXIT.OK, ...ref, withdrawn: true }, opId);
    }
    const hide = optStr(a, "hide_until");
    if (hide !== undefined) {
      if (Number.isNaN(Date.parse(hide))) throw new UsageError("hide_until must be a date and time");
      if (st !== "presented") return { code: EXIT.NOT_ALLOWED, message: `only a presented request can be hidden; this one is ${st}` };
      return this.commit("answer", "request.hidden", actor, { ...ref, until: hide }, { code: EXIT.OK, ...ref, hidden_until: hide }, opId);
    }
    const answer = this.answerRecord(rev, a, actor, at);
    const afterEffect = st === "executing" || st === "applied" || st === "outcome_unknown";
    const result: OpResult = { code: EXIT.OK, ...ref, answer };
    if (afterEffect) {
      result.message = "recorded as the current answer; it can't stop the effect already under way, and it governs everything after it";
    }
    return this.commit("answer", "answer.recorded", actor, { ...ref, answer, after_effect: afterEffect }, result, opId);
  }

  private wait(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    const req = this.reqOf(rev);
    if (rev.revision !== req.current) return this.replaced(rev, req);
    const at = this.now().toISOString();
    const st = this.effective(rev, at);
    if (st === "closed") return { code: EXIT.OK, status: st, message: "a notice needs no answer" };
    const closed = this.closedResult(st);
    if (closed) return { ...closed, status: st };
    if (st === "draft" || st === "queued" || st === "presented" || st === "hidden" || st === "default_claimed") {
      return { code: EXIT.WAITING, status: st };
    }
    const isOwner = sameActor(req.owner, actor);
    const base = { id: rev.id, revision: rev.revision, status: st, answer: rev.answer ?? null, role: isOwner ? "owner" : "observer" };
    const last = this.lastGrant(rev);
    switch (st) {
      case "late_conflict":
        return { code: EXIT.LATE_CONFLICT, ...base, message: "the person answered differently after the default ran; resolve the conflict before acting" };
      case "outcome_unknown":
        return { code: EXIT.NOT_ALLOWED, ...base, message: "an earlier effect may or may not have happened; record what recovery found with utp reconcile first" };
      case "executing":
      case "applied":
        return { code: EXIT.OK, ...base, grant: isOwner ? (last ?? null) : null };
      case "granted":
        return { code: EXIT.OK, ...base, grant: isOwner ? (last ?? null) : null };
      case "answered":
        break;
      default:
        return { code: EXIT.NOT_ALLOWED, ...base, message: `waiting isn't possible while the request is ${st}` };
    }
    const answer = rev.answer;
    if (!answer) return { code: EXIT.WAITING, ...base };
    const auth = this.authorizationFor(rev, answer);
    if (!auth) return { code: EXIT.OK, ...base, grant: null };
    if (!isOwner) {
      return { code: EXIT.OK, ...base, grant: null, message: "only the request's owner can act on this answer; file your own request to act" };
    }
    if (rev.body.level === 3 && !strongProvenance(answer)) {
      return {
        code: EXIT.PROVENANCE, ...base,
        message: `this answer came through ${answer.channel} with no proof that the person gave it, and the action it authorizes is level 3; ask the person to answer in their own terminal with utp review`,
      };
    }
    if (this.recoveryNeedsNewScope(rev, auth)) {
      return { code: EXIT.NOT_ALLOWED, ...base, message: "the answer changed after a partial effect; reconcile what remains under the current answer" };
    }
    const changed = this.changedBasis(rev, basisArg(a.basis));
    if (changed.length) {
      return this.commit("wait", "request.stale", actor, { id: rev.id, revision: rev.revision, changed, step: "wait" },
        { code: EXIT.STALE, ...base, status: "stale", changed, message: "a precondition changed; re-ask with utp revise" }, opId);
    }
    return this.issueGrant(rev, actor, { option: answer.value ?? "", authorization: auth, provenance: answer.verified, from_default: false },
      { code: EXIT.OK, ...base }, opId);
  }

  private claimDefault(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    const req = this.reqOf(rev);
    if (rev.revision !== req.current) return this.replaced(rev, req);
    const status = this.effective(rev, this.now().toISOString());
    const closed = this.closedResult(status);
    if (closed) return closed;
    const ref = { id: rev.id, revision: rev.revision, status, answer: rev.answer ?? null };
    if (rev.answer) return { code: EXIT.ANSWER_FIRST, ...ref, message: "the person answered before the default was claimed" };
    if (!sameActor(req.owner, actor)) {
      return { code: EXIT.NOT_ALLOWED, ...ref, message: "only the request owner can claim its default" };
    }
    const last = this.lastGrant(rev);
    if (status === "default_claimed" && last?.status === "active") return { code: EXIT.DEFAULT_CLAIMED, ...ref, grant: last };
    const eligible = eligibleDefault(rev.body);
    if (status !== "presented" || !eligible || this.recoveryNeedsNewScope(rev, eligible.authorization)) {
      return { code: EXIT.NOT_ALLOWED, ...ref, message: "this request does not have an eligible default ready to claim" };
    }
    const changed = this.changedBasis(rev, basisArg(a.basis));
    if (changed.length) {
      return this.commit("claim-default", "request.stale", actor, { id: rev.id, revision: rev.revision, changed, step: "claim-default" },
        { code: EXIT.STALE, ...ref, status: "stale", changed, message: "a precondition changed; re-ask with utp revise" }, opId);
    }
    return this.issueGrant(rev, actor, { ...eligible, provenance: "none", from_default: true },
      { code: EXIT.DEFAULT_CLAIMED, ...ref }, opId);
  }

  private issueGrant(rev: Rev, actor: Actor, source: Pick<Grant, "option" | "authorization" | "provenance" | "from_default">,
    result: OpResult, opId?: string, redoBasis?: Basis): OpResult {
    const at = this.now().toISOString();
    const grant: Grant = {
      ...source,
      id: newId("G", at),
      request_id: rev.id,
      revision: rev.revision,
      owner: actor,
      epoch: this.reqOf(rev).epoch,
      issued_at: at,
      lease_until: new Date(Date.parse(at) + GRANT_LEASE_MS).toISOString(),
      authorization: { ...source.authorization, ...(!redoBasis && rev.remaining_scope ? { scope: rev.remaining_scope } : {}) },
      status: "active",
    };
    const op = redoBasis ? "resolve-late" : grant.from_default ? "claim-default" : "wait";
    return this.commit(op, "grant.issued", actor, { grant, ...(redoBasis ? { redo_basis: redoBasis } : {}) },
      { ...result, status: grant.from_default ? "default_claimed" : "granted", grant }, opId);
  }

  private resolveLate(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    const req = this.reqOf(rev);
    if (rev.revision !== req.current) return this.replaced(rev, req);
    if (rev.status !== "late_conflict" || !rev.default_application || !sameActor(req.owner, actor)) {
      return { code: EXIT.NOT_ALLOWED, message: "only the request owner can resolve an open late conflict" };
    }
    const resolution = str(a, "resolution");
    const ref = { id: rev.id, revision: rev.revision };
    if (resolution === "keep") {
      return this.commit("resolve-late", "default.kept", actor, ref, { code: EXIT.OK, ...ref, status: "applied" }, opId);
    }
    if (resolution !== "redo") throw new UsageError("resolution must be keep or redo");
    const answer = rev.answer;
    const authorization = answer && this.authorizationFor(rev, answer);
    if (!answer || !authorization) {
      return { code: EXIT.NOT_ALLOWED, ...ref, message: "the later answer has no authorization for a redo" };
    }
    const basis = rev.default_application.basis;
    const changed = this.changedBasis(rev, basisArg(a.basis), basis);
    if (changed.length) {
      return this.commit("resolve-late", "request.stale", actor, { ...ref, changed, step: "resolve-late" },
        { code: EXIT.STALE, ...ref, status: "stale", changed, message: "the target changed after the default ran; re-ask with utp revise" }, opId);
    }
    return this.issueGrant(rev, actor, { option: answer.value ?? "", authorization, provenance: answer.verified, from_default: false },
      { code: EXIT.OK, ...ref, answer }, opId, basis);
  }

  private begin(a: Args, actor: Actor, opId?: string): OpResult {
    const found = this.grantContext(a);
    if ("code" in found) return found;
    const { g, rev, req } = found;
    const refused = this.grantRefusal(g, rev, req, actor);
    if (refused) return refused;
    if (g.status !== "active" || rev.status !== (g.from_default ? "default_claimed" : "granted") || this.lastGrant(rev)?.id !== g.id) {
      return { code: EXIT.NOT_ALLOWED, grant: g.id, message: "this grant was already used; a grant allows one action" };
    }
    const changed = this.changedBasis(rev, basisArg(a.basis));
    if (changed.length) {
      return this.commit("begin", "request.stale", actor, { id: rev.id, revision: rev.revision, changed, step: "begin" },
        { code: EXIT.STALE, grant: g.id, changed, message: "a precondition changed; don't act. Re-ask with utp revise" }, opId);
    }
    return this.commit("begin", "grant.begun", actor, { grant: g.id },
      { code: EXIT.OK, grant: g.id, authorization: g.authorization, lease_until: g.lease_until }, opId);
  }

  private applied(a: Args, actor: Actor, opId?: string): OpResult {
    const found = this.grantContext(a);
    if ("code" in found) return found;
    const { g, rev, req } = found;
    const refused = this.grantRefusal(g, rev, req, actor);
    if (refused) return refused;
    if (g.status === "active") {
      return { code: EXIT.NOT_ALLOWED, grant: g.id, message: "run utp begin immediately before the effect, and utp applied after it" };
    }
    if (g.status !== "used" || rev.status !== "executing") {
      return { code: EXIT.NOT_ALLOWED, grant: g.id, message: rev.status === "outcome_unknown"
        ? "the lease ran out before the effect was recorded; record what happened with utp reconcile"
        : "this grant's outcome is already recorded" };
    }
    const evidence = this.evidenceArg(a.evidence);
    const mismatch = (["action", "target", "scope"] as const)
      .filter((f) => normalize(String(evidence[f])) !== normalize(g.authorization[f]));
    const appliedBasis = g.from_default && !mismatch.length ? this.appliedDefaultBasis(rev, a.applied_basis) : undefined;
    const conflict = appliedBasis && contradictsDefault(rev.answer, g.option);
    const result: OpResult = {
      code: conflict ? EXIT.LATE_CONFLICT : EXIT.OK,
      grant: g.id, status: mismatch.length ? "outcome_unknown" : conflict ? "late_conflict" : "applied", mismatch,
    };
    if (mismatch.length) {
      result.message = `the reported ${mismatch.join(", ")} differ from what was authorized; the request stays outcome_unknown until utp reconcile records what happened`;
    } else if (conflict) {
      result.message = "the person answered differently after the default began; check the later answer before any further action";
    }
    return this.commit("applied", "grant.applied", actor,
      { grant: g.id, evidence, mismatch, ...(appliedBasis ? { applied_default_basis: appliedBasis } : {}) }, result, opId);
  }

  private reconcile(a: Args, actor: Actor, opId?: string): OpResult {
    const found = this.grantContext(a);
    if ("code" in found) return found;
    const { g, rev } = found;
    const current = rev.answer && this.authorizationFor(rev, rev.answer);
    const updatingScope = a.outcome === "partial" && rev.status === "answered" && g.status === "done"
      && current && this.recoveryNeedsNewScope(rev, current);
    if ((rev.status !== "outcome_unknown" && !updatingScope) || this.lastGrant(rev)?.id !== g.id) {
      return { code: EXIT.NOT_ALLOWED, grant: g.id, message: `there's nothing to reconcile: the request is ${rev.status}` };
    }
    const outcome = str(a, "outcome") as Outcome;
    if (!OUTCOMES.includes(outcome)) throw new UsageError(`outcome must be one of: ${OUTCOMES.join(", ")}`);
    const evidence = this.objArg(a.evidence, "evidence");
    const data: Args = { grant: g.id, outcome, evidence };
    let unanticipated = false;
    if (outcome === "partial") {
      unanticipated = a.unanticipated === true;
      const recovery = basisArg(a.recovery_basis) ?? {};
      const missing = Object.keys(rev.basis).filter((p) => !(p in recovery));
      if (missing.length) throw new UsageError(`the recovery basis needs a fingerprint for ${missing.join(", ")}`);
      const remaining = str(a, "remaining_scope");
      const started = this.authorizationAtGrant(rev, g);
      if (!unanticipated && current && !sameAuthorization(started, current)
          && (!sameTarget(started, current) || remaining !== current.scope)) {
        return {
          code: EXIT.NOT_ALLOWED, grant: g.id,
          message: "the answer changed after execution began; confirm the current authorized scope is exactly what remains, or mark the partial effect unanticipated",
        };
      }
      Object.assign(data, {
        recovery_basis: recovery, remaining_scope: remaining, recovery_authorization: current ?? started, unanticipated,
      });
    }
    let status = this.reconcileTarget(rev, outcome, unanticipated);
    if (g.from_default && outcome === "completed") {
      data.applied_default_basis = this.appliedDefaultBasis(rev, a.applied_basis);
      if (contradictsDefault(rev.answer, g.option)) status = "late_conflict";
    }
    return this.commit("reconcile", "grant.reconciled", actor, data, { code: EXIT.OK, grant: g.id, outcome, status }, opId);
  }

  private revise(a: Args, actor: Actor, opId?: string): OpResult {
    const req = this.reqs.get(str(a, "id").split("@")[0] ?? "");
    if (!req) return notFound(a.id);
    if (!sameActor(req.owner, actor)) {
      return { code: EXIT.NOT_ALLOWED, message: "only the request's owner can revise it; take it over first if the owner is gone" };
    }
    const rev = this.current(req);
    const st = this.effective(rev, this.now().toISOString());
    if (!canTransition(st, "superseded")) {
      return { code: EXIT.NOT_ALLOWED, message: `a ${st} request can't be revised${st === "outcome_unknown" ? "; reconcile it first" : ""}` };
    }
    const body = a.body as RequestBody;
    const failures = checkRequest(body);
    if (failures.length) return { code: EXIT.CHECK_FAILED, failures };
    const basis = this.basisFor(body, basisArg(a.basis));
    const revision = rev.revision + 1;
    const review_id = this.openReviewId ?? newId("V", this.now().toISOString());
    return this.commit("revise", "request.revised", actor, { id: req.id, revision, basis, review_id },
      { code: EXIT.OK, id: req.id, revision, review_id, superseded: rev.revision }, opId, { body });
  }

  private cancel(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    const req = this.reqOf(rev);
    if (rev.revision !== req.current) return this.replaced(rev, req);
    if (!sameActor(req.owner, actor)) return { code: EXIT.NOT_ALLOWED, message: "only the request's owner can cancel it" };
    const st = this.effective(rev, this.now().toISOString());
    if (!canTransition(st, "cancelled")) return { code: EXIT.NOT_ALLOWED, message: `a ${st} request can't be cancelled` };
    const reason = optStr(a, "reason");
    return this.commit("cancel", "request.cancelled", actor, { id: rev.id, revision: rev.revision, ...(reason ? { reason } : {}) },
      { code: EXIT.OK, id: rev.id, revision: rev.revision, status: "cancelled" }, opId);
  }

  private release(a: Args, actor: Actor, opId?: string): OpResult {
    const found = this.grantContext(a);
    if ("code" in found) return found;
    const { g } = found;
    if (!sameActor(g.owner, actor)) return { code: EXIT.NOT_ALLOWED, grant: g.id, message: "this grant belongs to another session" };
    if (g.status !== "active") return { code: EXIT.NOT_ALLOWED, grant: g.id, message: `only an unused grant can be released; this one is ${g.status}` };
    return this.commit("release", "grant.released", actor, { grant: g.id }, { code: EXIT.OK, grant: g.id, status: "released" }, opId);
  }

  private takeover(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    const req = this.reqOf(rev);
    if (rev.revision !== req.current) return this.replaced(rev, req);
    if (sameActor(req.owner, actor)) return { code: EXIT.OK, id: req.id, epoch: req.epoch, message: "this session already owns the request" };
    const st = this.effective(rev, this.now().toISOString());
    if (st === "executing") {
      return { code: EXIT.NOT_ALLOWED, message: "a grant is in use; takeover is allowed after its lease runs out and its outcome is reconciled" };
    }
    if (st === "outcome_unknown") return { code: EXIT.NOT_ALLOWED, message: "record what happened with utp reconcile before taking over" };
    if (TERMINAL.has(st) || st === "applied") return { code: EXIT.NOT_ALLOWED, message: `a ${st} request has nothing to take over` };
    const g = this.lastGrant(rev);
    const active = (st === "granted" || st === "default_claimed") && g?.status === "active" ? g : undefined;
    if (active) {
      const idle = this.now().getTime() - Date.parse(active.issued_at);
      if (idle < TAKEOVER_IDLE_MS) {
        return {
          code: EXIT.NOT_ALLOWED,
          retry_after_s: Math.ceil((TAKEOVER_IDLE_MS - idle) / 1000),
          message: "the owner's unused grant has been idle under 15 minutes; takeover is allowed after that, or as soon as the owner releases it",
        };
      }
    }
    const epoch = req.epoch + 1;
    return this.commit("takeover", "request.taken_over", actor,
      { id: req.id, owner: actor, previous: req.owner, epoch, ...(active ? { grant: active.id } : {}) },
      { code: EXIT.OK, id: req.id, epoch, ...(active ? { revoked_grant: active.id } : {}) }, opId);
  }

  private reverse(a: Args, actor: Actor, opId?: string): OpResult {
    const rev = this.resolve(str(a, "id"));
    if (!rev) return notFound(a.id);
    if (!rev.answer && rev.status !== "applied") {
      return { code: EXIT.NOT_ALLOWED, message: "only an answered or applied decision can be reversed" };
    }
    const reason = str(a, "reason");
    const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [];
    return this.commit("reverse", "request.reversed", actor, { id: rev.id, revision: rev.revision, reason, tags },
      { code: EXIT.OK, id: rev.id, revision: rev.revision, reversed: true }, opId);
  }

  private show(a: Args): OpResult {
    const ref = str(a, "id");
    if (ref.startsWith("G-")) {
      const g = this.grants.get(ref);
      if (!g) return notFound(ref);
      return { code: EXIT.OK, grant: g, request: this.view(this.revs.get(key(g.request_id, g.revision)) as Rev) };
    }
    if (ref.startsWith("V-")) {
      const v = this.reviews.get(ref);
      if (!v) return notFound(ref);
      const items = v.items.map((k) => this.revs.get(k)).filter((r): r is Rev => r !== undefined).map((r) => this.view(r));
      return { code: EXIT.OK, review: { id: v.id, status: v.status, presentations: v.presentations, items,
        ...(v.default_notices?.length ? { default_notices: v.default_notices } : {}) } };
    }
    const rev = this.resolve(ref);
    if (!rev) return notFound(ref);
    return { code: EXIT.OK, request: this.view(rev) };
  }

  private status(): OpResult {
    const at = this.now().toISOString();
    const requests = [...this.revs.values()]
      .filter((r) => this.isCurrentRev(r) && this.isOpen(r))
      .map((r) => ({ id: r.id, revision: r.revision, kind: r.body.kind, level: r.body.level, status: this.effective(r, at),
        question: r.body.question, review_id: r.review_id, flags: r.flags }));
    const waiting = new Set(["queued", "presented", "hidden"]);
    const reviews = [...this.reviews.values()]
      .filter((v) => v.items.some((k) => {
        const r = this.revs.get(k);
        return r !== undefined && this.isCurrentRev(r) && waiting.has(this.effective(r, at));
      }))
      .map((v) => ({ id: v.id, status: v.status, presentations: v.presentations.length, items: v.items }));
    return { code: EXIT.OK, requests, reviews, open_review: this.openReviewId ?? null };
  }

  private log(a: Args): OpResult {
    const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [];
    const related = optStr(a, "related");
    const text = optStr(a, "text")?.toLowerCase();
    const kind = optStr(a, "kind");
    const candidates = this.logEntries();
    for (const archive of this.archives.values()) {
      for (const { entry, searchText } of archive.decisions) {
        candidates.push({ entry: { ...entry, origin_project: archive.origin, archived: true }, searchText });
      }
    }
    const entries = candidates.filter(({ entry, searchText }) => {
      const allTags = [...entry.tags, ...entry.reversals.flatMap((r) => r.tags)];
      return (!kind || entry.kind === kind)
        && (!tags.length || allTags.some((tag) => tags.includes(tag)))
        && (!related || entry.id === related || entry.related.includes(related))
        && (!text || searchText.includes(text));
    }).map(({ entry }) => entry);
    return { code: EXIT.OK, entries };
  }

  private logEntries(): SearchableDecision[] {
    const at = this.now().toISOString();
    return [...this.reqs.values()].map((req) => {
      const rev = this.current(req);
      const b = rev.body;
      return {
        entry: {
          id: req.id, revision: rev.revision, kind: b.kind, level: b.level, question: b.question,
          status: this.effective(rev, at), answer: rev.answer?.value ?? rev.answer?.disposition ?? null,
          tags: b.tags ?? [], related: b.related ?? [], reversals: req.reversals, asked_at: rev.asked_at,
        },
        searchText: [b.question, b.why_now, b.notes ?? "", rev.answer?.custom ?? "", rev.answer?.note ?? "",
          ...req.reversals.map((r) => r.reason)].join(" ").toLowerCase(),
      };
    });
  }

  private hasRelinkWork(): boolean {
    if ([...this.grants.values()].some((grant) => grant.status === "active" || grant.status === "used")) return true;
    return [...this.reqs.values()].some((req) => {
      const rev = this.current(req);
      if (rev.status === "answered" && rev.answer && !this.authorizationFor(rev, rev.answer)) return false;
      return this.isOpen(rev);
    });
  }

  // ---- event application --------------------------------------------------

  private apply(e: StoredEvent): void {
    const d = e.data;
    switch (e.type) {
      case "project.archived": {
        const payload = e.payloads?.archives;
        if (!payload) throw new CorruptStoreError(`archive event ${e.seq} has no snapshot`);
        for (const archive of this.store.getPayload<DecisionArchive[]>(payload)) {
          this.archives.set(archive.origin, archive);
        }
        break;
      }
      case "request.asked": {
        const id = d.id as string;
        this.reqs.set(id, { id, current: d.revision as number, owner: d.owner as Actor, epoch: 1, observers: [], reversals: [] });
        this.addRev(e, id, d.revision as number);
        break;
      }
      case "request.attached":
        this.reqs.get(d.id as string)?.observers.push(d.observer as Actor);
        break;
      case "request.revised": {
        const req = this.mustReq(d.id);
        const old = this.current(req);
        this.revoke(old);
        this.move(old, "superseded", e.at);
        req.current = d.revision as number;
        this.addRev(e, req.id, req.current);
        break;
      }
      case "review.flushed": {
        const v = this.reviews.get(d.review_id as string);
        if (!v) throw new CorruptStoreError(`flush of unknown review ${String(d.review_id)}`);
        v.items = v.items.filter((k) => this.revs.get(k)?.status === "queued");
        v.status = "prepared";
        v.default_notices = (d.default_notices as DefaultNotice[] | undefined) ?? [];
        if (this.openReviewId === v.id) this.openReviewId = undefined;
        break;
      }
      case "review.presented": {
        const v = this.reviews.get(d.review_id as string);
        if (!v) throw new CorruptStoreError(`presentation of unknown review ${String(d.review_id)}`);
        for (const notice of v.default_notices ?? []) {
          const rev = this.revs.get(key(notice.request_id, notice.revision));
          if (rev && (rev.status === "late_conflict") === notice.conflict) rev.default_notice_pending = false;
        }
        v.presentations.push({ id: d.presentation_id as string, channel: d.channel as string, at: e.at });
        for (const k of v.items) {
          const r = this.revs.get(k);
          if (!r || !this.isCurrentRev(r) || !this.isOpen(r)) continue;
          if (r.status === "queued") {
            this.move(r, "presented", e.at);
            if (r.body.kind === "notice") this.move(r, "closed", e.at);
          }
          r.presented_at = e.at;
        }
        break;
      }
      case "answer.recorded": {
        const r = this.mustRev(d);
        r.answer = d.answer as AnswerRecord;
        r.answer_count += 1;
        const st = this.effective(r, e.at);
        if (st === "granted" || st === "default_claimed") this.revoke(r);
        if (st === "granted" || st === "default_claimed" || st === "presented" || st === "hidden" || st === "answered") {
          this.move(r, "answered", e.at);
        }
        this.checkLateConflict(r, e.at);
        break;
      }
      case "answer.withdrawn": {
        const r = this.mustRev(d);
        r.answer = undefined;
        const st = this.effective(r, e.at);
        if (st === "granted") this.revoke(r);
        if (st === "granted" || st === "answered") this.move(r, "presented", e.at);
        break;
      }
      case "request.hidden": {
        const r = this.mustRev(d);
        this.move(r, "hidden", e.at);
        r.hide_until = d.until as string;
        break;
      }
      case "request.stale":
      case "request.cancelled":
      case "request.expired": {
        const r = this.mustRev(d);
        this.revoke(r);
        this.move(r, e.type === "request.stale" ? "stale" : e.type === "request.cancelled" ? "cancelled" : "expired", e.at);
        break;
      }
      case "request.reversed":
        this.mustReq(d.id).reversals.push({ at: e.at, reason: d.reason as string, tags: d.tags as string[] });
        break;
      case "request.taken_over": {
        const req = this.mustReq(d.id);
        req.owner = d.owner as Actor;
        req.epoch = d.epoch as number;
        if (typeof d.grant === "string") {
          const g = this.mustGrant(d.grant);
          g.status = "taken_over";
          this.move(this.revOf(g), g.from_default ? "presented" : "answered", e.at);
        }
        break;
      }
      case "grant.issued": {
        const g = { ...(d.grant as Grant) };
        this.grants.set(g.id, g);
        const r = this.revOf(g);
        r.grants.push(g.id);
        if (d.redo_basis) {
          r.expected_basis = d.redo_basis as Basis;
          r.default_resolution = "redo";
          delete r.remaining_scope;
          delete r.recovery_authorization;
        }
        this.move(r, g.from_default ? "default_claimed" : "granted", e.at);
        break;
      }
      case "grant.begun": {
        const g = this.mustGrant(d.grant);
        g.status = "used";
        g.used_at = e.at;
        this.move(this.revOf(g), "executing", e.at);
        break;
      }
      case "grant.applied": {
        const g = this.mustGrant(d.grant);
        const r = this.revOf(g);
        g.status = "done";
        const mismatch = d.mismatch as string[];
        if (mismatch.length) r.flags.push(`effect differs from authorization: ${mismatch.join(", ")}`);
        this.move(r, mismatch.length ? "outcome_unknown" : "applied", e.at);
        this.recordDefaultApplication(r, g, d, e.at);
        break;
      }
      case "default.kept": {
        const r = this.mustRev(d);
        r.default_resolution = "keep";
        this.move(r, "applied", e.at);
        break;
      }
      case "grant.lease_expired": {
        const g = this.mustGrant(d.grant);
        const r = this.revOf(g);
        if (d.used === true) {
          r.flags.push("lease ran out before the effect was recorded");
          this.move(r, "outcome_unknown", e.at);
        } else {
          g.status = "expired";
          this.move(r, g.from_default ? "presented" : "answered", e.at);
        }
        break;
      }
      case "grant.released": {
        const g = this.mustGrant(d.grant);
        g.status = "released";
        this.move(this.revOf(g), g.from_default ? "presented" : "answered", e.at);
        break;
      }
      case "grant.reconciled": {
        const g = this.mustGrant(d.grant);
        const r = this.revOf(g);
        const outcome = d.outcome as Outcome;
        const target = this.reconcileTarget(r, outcome, d.unanticipated === true);
        g.status = outcome === "unknown" ? "used" : "done";
        if (outcome === "different") r.flags.push("reconciled as different from what was authorized");
        if (outcome === "partial") {
          const recovery = d.recovery_basis as Basis;
          if (Object.keys(recovery).length) r.expected_basis = { ...recovery };
          r.remaining_scope = d.remaining_scope as string;
          r.recovery_authorization = (d.recovery_authorization as Authorization | undefined) ?? this.authorizationAtGrant(r, g);
        }
        r.reconciliations.push({ at: e.at, outcome, grant: g.id });
        if (target !== r.status) this.move(r, target, e.at);
        this.recordDefaultApplication(r, g, d, e.at);
        break;
      }
      default:
        throw new CorruptStoreError(`event ${e.seq} has an unknown type: ${e.type}`);
    }
  }

  // ---- helpers ------------------------------------------------------------

  private commit(op: string, type: string, actor: Actor, data: Args, result: OpResult, opId?: string,
    payloads?: Record<string, unknown>): OpResult {
    const event = this.store.append(
      { type, at: this.now().toISOString(), ...(opId ? { op_id: opId } : {}), actor, data: { op, ...data }, result },
      payloads,
    );
    this.apply(event);
    this.events.emit("commit", event);
    return result;
  }

  /** Records lease and expiry deadlines that passed since the last operation. */
  private sweep(): void {
    const now = this.now().getTime();
    for (const g of this.grants.values()) {
      if (Date.parse(g.lease_until) > now) continue;
      const rev = this.revOf(g);
      if (g.status === "active" || (g.status === "used" && rev.status === "executing")) {
        this.commit("sweep", "grant.lease_expired", SYSTEM, { grant: g.id, used: g.status === "used" }, { code: EXIT.OK });
      }
    }
    for (const r of this.revs.values()) {
      const exp = r.body.expires_at;
      if (exp && Date.parse(exp) <= now && this.isCurrentRev(r) && this.effective(r, new Date(now).toISOString()) === "presented") {
        this.commit("sweep", "request.expired", SYSTEM, { id: r.id, revision: r.revision }, { code: EXIT.OK });
      }
    }
  }

  private addRev(e: StoredEvent, id: string, revision: number): void {
    const sha = e.payloads?.body;
    if (!sha) throw new CorruptStoreError(`event ${e.seq} has no request body`);
    const basis = { ...(e.data.basis as Basis) };
    const review_id = e.data.review_id as string;
    const r: Rev = {
      key: key(id, revision), id, revision, body: this.store.getPayload<RequestBody>(sha), body_sha: sha,
      status: "queued", basis, expected_basis: { ...basis }, review_id, asked_at: e.at,
      answer_count: 0, grants: [], flags: [], reconciliations: [],
    };
    this.revs.set(r.key, r);
    let v = this.reviews.get(review_id);
    if (!v) {
      v = { id: review_id, status: "open", items: [], presentations: [] };
      this.reviews.set(review_id, v);
      this.openReviewId = review_id;
    }
    v.items.push(r.key);
  }

  private move(r: Rev, to: State, at: string): void {
    assertTransition(this.effective(r, at), to);
    r.status = to;
    if (to !== "hidden") delete r.hide_until;
  }

  private revoke(r: Rev): void {
    for (const id of r.grants) {
      const g = this.grants.get(id);
      if (g?.status === "active") g.status = "revoked";
    }
  }

  private effective(r: Rev, at: string): State {
    if (r.status === "hidden" && r.hide_until && Date.parse(r.hide_until) <= Date.parse(at)) return "presented";
    return r.status;
  }

  private reconcileTarget(r: Rev, outcome: Outcome, unanticipated: boolean): State {
    switch (outcome) {
      case "completed":
      case "different":
        return "applied";
      case "unknown":
        return "outcome_unknown";
      case "not-performed":
        return r.answer ? "answered" : "presented";
      case "partial":
        return unanticipated ? "stale" : r.answer ? "answered" : "presented";
    }
  }

  private authorizationAtGrant(rev: Rev, grant: Grant): Authorization {
    return rev.body.options?.find((option) => option.id === grant.option)?.authorization ?? grant.authorization;
  }

  private appliedDefaultBasis(rev: Rev, supplied: unknown): Basis {
    const basis = basisArg(supplied) ?? {};
    if (Object.keys(rev.basis).some((path) => !(path in basis))) {
      throw new UsageError("record the basis fingerprints for the state the default left");
    }
    return basis;
  }

  private recordDefaultApplication(rev: Rev, grant: Grant, data: Args, at: string): void {
    if (!data.applied_default_basis) return;
    rev.default_application = { grant: grant.id, basis: data.applied_default_basis as Basis };
    rev.default_notice_pending = true;
    rev.flags.push("applied by default: change?");
    this.checkLateConflict(rev, at);
  }

  private checkLateConflict(rev: Rev, at: string): void {
    if (!rev.default_application || rev.default_resolution) return;
    const option = this.mustGrant(rev.default_application.grant).option;
    if (rev.status === "applied" && contradictsDefault(rev.answer, option)) {
      rev.flags.push("late answer conflicts with the applied default");
      rev.default_notice_pending = true;
      this.move(rev, "late_conflict", at);
    } else if (rev.status === "late_conflict" && rev.answer?.value === option) {
      this.move(rev, "applied", at);
    }
  }

  private recoveryNeedsNewScope(rev: Rev, current: Authorization): boolean {
    return rev.recovery_authorization !== undefined && !sameAuthorization(rev.recovery_authorization, current);
  }

  private closedResult(st: State): OpResult | undefined {
    switch (st) {
      case "cancelled": return { code: EXIT.CANCELLED, message: "the agent withdrew this request" };
      case "expired": return { code: EXIT.EXPIRED, message: "this request expired without an answer" };
      case "superseded": return { code: EXIT.REVOKED, message: "this revision was replaced by a newer one" };
      case "stale": return { code: EXIT.STALE, message: "a precondition changed; re-ask with utp revise" };
      case "closed": return { code: EXIT.NOT_ALLOWED, message: "notices need no answer" };
      default: return undefined;
    }
  }

  private grantRefusal(g: Grant, rev: Rev, req: Req, actor: Actor): OpResult | undefined {
    const at = { grant: g.id };
    if (g.status === "taken_over" || g.epoch !== req.epoch) {
      return { code: EXIT.EPOCH, ...at, message: "another session took this request over; this grant's lease epoch is outdated" };
    }
    if (!sameActor(g.owner, actor)) return { code: EXIT.NOT_ALLOWED, ...at, message: "this grant belongs to another session" };
    if (rev.status === "stale") return { code: EXIT.STALE, ...at, message: "a precondition changed; don't act. Re-ask with utp revise" };
    if (rev.status === "cancelled") return { code: EXIT.CANCELLED, ...at, message: "the request was cancelled" };
    if (g.status === "revoked" || g.status === "released") {
      return { code: EXIT.REVOKED, ...at, message: "the answer behind this grant was revised or withdrawn, or the request was replaced" };
    }
    if (g.status === "expired") return { code: EXIT.EXPIRED, ...at, message: "the grant's lease ran out before it was used; run utp wait again" };
    return undefined;
  }

  private grantContext(a: Args): { g: Grant; rev: Rev; req: Req } | OpResult {
    const g = this.grants.get(str(a, "grant"));
    if (!g) return notFound(a.grant);
    const rev = this.revOf(g);
    return { g, rev, req: this.reqOf(rev) };
  }

  private answerRecord(rev: Rev, a: Args, actor: Actor, at: string): AnswerRecord {
    const options = rev.body.options ?? [];
    const value = optStr(a, "value") ?? null;
    if (value !== null && !options.some((o) => o.id === value)) {
      throw new UsageError(`option ${value} isn't on this card; its options are ${options.map((o) => o.id).join(", ") || "none"}`);
    }
    const disposition = optStr(a, "disposition") as Disposition | undefined;
    if (disposition !== undefined && disposition !== "answered_elsewhere" && disposition !== "no_longer_matters") {
      throw new UsageError("disposition must be answered_elsewhere or no_longer_matters");
    }
    const custom = optStr(a, "custom");
    let items: Record<string, string> | undefined;
    if (a.items !== undefined) {
      if (typeof a.items !== "object" || a.items === null || Array.isArray(a.items)
        || !Object.values(a.items).every((v) => typeof v === "string")) {
        throw new UsageError("items must map each item id to its answer");
      }
      items = a.items as Record<string, string>;
    }
    if (value === null && !custom && !disposition && !items) {
      throw new UsageError("an answer needs an option, your own words, item answers, or a disposition");
    }
    const sureness = optStr(a, "sureness");
    if (sureness !== undefined && !["sure", "leaning", "unsure"].includes(sureness)) {
      throw new UsageError("sureness must be sure, leaning or unsure");
    }
    const channel = str(a, "channel");
    const record: AnswerRecord = {
      value, channel, verified: PERSON_CHANNELS[channel] ?? "none", machine: actor.machine, session: actor.session, at,
    };
    const extra: Partial<AnswerRecord> = {
      custom, items, disposition, sureness: sureness as AnswerRecord["sureness"],
      feedback: optStr(a, "feedback"), note: optStr(a, "note"), quote: optStr(a, "quote"),
      addressed: a.addressed === true ? true : undefined,
    };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) (record as unknown as Args)[k] = v;
    return record;
  }

  private evidenceArg(v: unknown): { action: string; target: string; scope: string; effect: string } & Args {
    const ev = this.objArg(v, "evidence");
    for (const f of ["action", "target", "scope", "effect"]) {
      if (typeof ev[f] !== "string" || (ev[f] as string).trim() === "") {
        throw new UsageError(`evidence needs ${f}: restate the action, target and scope you carried out, and describe the effect`);
      }
    }
    return ev as { action: string; target: string; scope: string; effect: string } & Args;
  }

  private objArg(v: unknown, name: string): Args {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new UsageError(`${name} must be a JSON object`);
    return v as Args;
  }

  private basisFor(body: RequestBody, supplied: Basis | undefined): Basis {
    const out: Basis = {};
    for (const p of body.basis?.files ?? []) {
      const sha = supplied?.[p];
      if (!sha) throw new UsageError(`no fingerprint for basis file ${p}; the utp client computes these`);
      out[p] = sha;
    }
    return out;
  }

  private changedBasis(r: Rev, supplied: Basis | undefined, expected = r.expected_basis): string[] {
    const paths = Object.keys(expected);
    if (paths.length === 0) return [];
    if (!supplied) throw new UsageError("this request has basis files; pass their current fingerprints (the utp client does this)");
    return paths.filter((p) => supplied[p] !== expected[p]);
  }

  private authorizationFor(r: Rev, a: AnswerRecord): Authorization | undefined {
    if (a.disposition || a.value === null) return undefined;
    return r.body.options?.find((o) => o.id === a.value)?.authorization;
  }

  private replaced(rev: Rev, req: Req): OpResult {
    return {
      code: EXIT.REVOKED, current: key(req.id, req.current),
      message: `revision ${rev.revision} was replaced by revision ${req.current}; answers and grants never carry over to a newer revision`,
    };
  }

  private view(r: Rev): Args {
    const req = this.reqOf(r);
    return {
      id: r.id, revision: r.revision, current: r.revision === req.current, status: this.effective(r, this.now().toISOString()),
      body: r.body, basis_files: Object.keys(r.basis), answer: r.answer ?? null, answers: r.answer_count,
      grants: r.grants.map((g) => this.grants.get(g)), flags: r.flags, review_id: r.review_id, asked_at: r.asked_at,
      presented_at: r.presented_at ?? null, hide_until: r.hide_until ?? null, remaining_scope: r.remaining_scope ?? null,
      reconciliations: r.reconciliations, reversals: req.reversals, owner: req.owner, observers: req.observers.length,
      epoch: req.epoch,
    };
  }

  private resolve(ref: string): Rev | undefined {
    const [id, revText] = ref.split("@");
    const req = this.reqs.get(id ?? "");
    if (!req) return undefined;
    return this.revs.get(key(req.id, revText === undefined ? req.current : Number(revText)));
  }

  private current(req: Req): Rev {
    const r = this.revs.get(key(req.id, req.current));
    if (!r) throw new CorruptStoreError(`request ${req.id} has no revision ${req.current}`);
    return r;
  }

  private lastGrant(r: Rev): Grant | undefined {
    const id = r.grants.at(-1);
    return id ? this.grants.get(id) : undefined;
  }

  private isCurrentRev(r: Rev): boolean {
    return this.reqs.get(r.id)?.current === r.revision;
  }

  private isOpen(r: Rev): boolean {
    return !TERMINAL.has(r.status) && r.status !== "applied";
  }

  private reqOf(r: Rev): Req {
    return this.mustReq(r.id);
  }

  private revOf(g: Grant): Rev {
    const r = this.revs.get(key(g.request_id, g.revision));
    if (!r) throw new CorruptStoreError(`grant ${g.id} names a missing revision`);
    return r;
  }

  private mustReq(id: unknown): Req {
    const req = this.reqs.get(id as string);
    if (!req) throw new CorruptStoreError(`unknown request ${String(id)}`);
    return req;
  }

  private mustRev(d: Args): Rev {
    const r = this.revs.get(key(d.id as string, d.revision as number));
    if (!r) throw new CorruptStoreError(`unknown revision ${String(d.id)}@${String(d.revision)}`);
    return r;
  }

  private mustGrant(id: unknown): Grant {
    const g = this.grants.get(id as string);
    if (!g) throw new CorruptStoreError(`unknown grant ${String(id)}`);
    return g;
  }
}
