import { lstatSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RequestView, ReviewView } from "../cli/render.js";
import { validTaskTitle } from "../core/check.js";
import { Engine } from "../core/engine.js";
import { EXIT, type Actor } from "../core/types.js";
import { escapeText, page, pinForm, pinnedDecisionsHtml } from "./review-html.js";
import type { DecisionPin } from "../core/decision-pins.js";
import { handleHistory, historySearch } from "./history-page.js";
import { answerable, ReviewPages, sendHtml } from "./review-page.js";
import { normalizeRemote, type ProjectInfo, type Service } from "./service.js";

const actor = { machine: "review-inbox", session: "browser" };

const KIND_SHORT: Record<string, string> = {
  choose: "choice", approve: "approval", handoff: "manual step", clarify: "clarify",
  accept: "result check", assumptions: "assumptions", notice: "notice", judge: "blind comparison",
};
const UNDO_SHORT: Record<string, string> = {
  easy: "easy to undo", costly: "costly to undo", one_way: "can't be undone",
};

function relativeAge(iso: string | undefined, nowMs: number): string | undefined {
  if (!iso) return undefined;
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function originSummary(cards: RequestView[]): string | undefined {
  const first = cards[0];
  if (!first) return undefined;
  const agent = first.body.origin?.agent || first.body.origin?.platform;
  const machine = first.owner?.machine;
  if (agent && machine) return `${agent} on ${machine}`;
  return agent || machine;
}

function stakesSummary(cards: RequestView[]): string {
  const approvals = cards.filter((c) => c.body.kind === "approve" || c.body.stakes.reversibility === "one_way").length;
  const reversible = cards.length - approvals;
  const parts: string[] = [];
  if (approvals) parts.push(`${approvals} ${approvals === 1 ? "approval" : "approvals"}`);
  if (reversible) parts.push(`${reversible} reversible`);
  return parts.join(" · ") || `${cards.length} ${cards.length === 1 ? "decision" : "decisions"}`;
}

// Release directories use full Git object IDs. Short hexadecimal names may be intentional project names.
const HASH_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Extract only the repository folder name for display. */
function remoteBasename(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const location = normalizeRemote(remote.split(/[?#]/, 1)[0]?.replaceAll("\\", "/"));
  if (!location?.includes("/")) return undefined;
  const base = path.posix.basename(location).replace(/\.git$/i, "");
  return SAFE_BASENAME.test(base) && !HASH_NAME.test(base) ? base : undefined;
}

/** Preserve the supplied name when it identifies the project. */
export function inboxLabel(project: ProjectInfo): string {
  if (project.name && !HASH_NAME.test(project.name)) return project.name;
  return remoteBasename(project.remote) ?? "Unnamed project";
}

/** Only the authenticating proxy and the UTP service may reach this socket. */
export function checkReviewerSocket(socket: string, origin?: URL): void {
  if (!process.getuid || !path.isAbsolute(socket) || origin?.protocol !== "https:") {
    throw new Error("the reviewer socket needs an absolute Unix socket path and an HTTPS review origin");
  }
  const parent = lstatSync(path.dirname(socket));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) {
    throw new Error("the reviewer socket needs a private directory owned by the service user (mode 0700)");
  }
}

interface Outstanding {
  review_id: string;
  kind: string;
  question: string;
  status: string;
}

export async function handleReviewerInbox(req: IncomingMessage, res: ServerResponse, service: Service, pages: ReviewPages,
  readBody: (req: IncomingMessage) => Promise<string | undefined>,
  waitersFor?: (project: string, reviewId: string) => Actor[]): Promise<void> {
  const unavailable = (code: number) => sendHtml(res, code, page("Review unavailable", "<h1>Review unavailable</h1>"));
  if (req.headers.host?.toLowerCase() !== pages.origin.host) return unavailable(403);
  const path = req.url ?? "";
  if (path.startsWith("/review/")) return pages.handle(req, res, readBody, true);
  const pin = /^\/pins\/(prj-[a-f0-9]{12})\/(R-[A-Za-z0-9-]+@\d+)\/(pin|unpin)$/.exec(path);
  if (pin && req.method === "POST") {
    if (req.headers.origin !== pages.origin.origin || !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return unavailable(403);
    const raw = await readBody(req);
    if (raw === undefined) return unavailable(413);
    const form = new URLSearchParams(raw);
    const project = pin[1]!, ref = pin[2]!, op = pin[3]!;
    const engine = service.engine(project);
    if (!(engine instanceof Engine)) return unavailable(engine.code === EXIT.NOT_FOUND ? 404 : 503);
    const expected = form.get("expected");
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return unavailable(400);
    const submission = form.get("submission");
    if (submission && !/^[0-9a-f-]{36}$/.test(submission)) return unavailable(400);
    const result = engine.run(op, { id: ref, expected }, actor, submission ? `inbox-pin:${submission}:${op}:${ref}` : undefined);
    if (result.code !== EXIT.OK) {
      return sendHtml(res, result.code === EXIT.NOT_FOUND ? 404 : 409, page("Pin unavailable",
        `<h1>Pin unavailable</h1><p>${escapeText(result.message ?? "This decision changed.")}</p><a href="/history">Review history</a>`));
    }
    const back = form.get("return") ?? "";
    const local = /^\/review\/[A-Za-z0-9_-]{32}$/.test(back)
      || (back.startsWith(`/history/${project}/`) && /^\/history\/prj-[a-f0-9]{12}\/V-[A-Za-z0-9-]+$/.test(back));
    res.writeHead(303, { location: local ? back : "/", "cache-control": "no-store" });
    res.end();
    return;
  }
  if (path === "/history" || path.startsWith("/history?") || path.startsWith("/history/")) {
    return handleHistory(req, res, service, pages, readBody, actor, inboxLabel);
  }
  if (path === "/" && req.method === "GET") {
    const sections: string[] = [];
    const pinSections: string[] = [];
    const recentEntries: { updatedAt: string; html: string }[] = [];
    const nowMs = Date.now();
    for (const project of service.projects()) {
      const engine = service.engine(project.id);
      if (!(engine instanceof Engine)) return unavailable(503);
      const label = inboxLabel(project);
      const status = engine.run("inbox", {}, actor);
      const pins = status.pins as DecisionPin[];
      if (pins.length) pinSections.push(pinnedDecisionsHtml({ project: project.id, pins, returnTo: "/" }, label));
      const groups = new Map<string, Outstanding[]>();
      for (const item of status.requests as Outstanding[]) {
        const list = groups.get(item.review_id) ?? [];
        list.push(item);
        groups.set(item.review_id, list);
      }
      for (const [reviewId] of groups) {
        const shown = engine.run("show", { id: reviewId }, actor).review as ReviewView | undefined;
        const waiting = (shown?.items ?? []).filter((c) => c.current && c.body.kind !== "notice" && answerable(c.status));
        if (!waiting.length) continue;
        const title = validTaskTitle(shown?.intent?.task_title)
          ? `<p class="inbox-title">${escapeText(shown!.intent!.task_title!)}</p>` : "";
        const oldest = waiting.map((c) => c.asked_at).filter((t): t is string => !!t).sort()[0];
        const metaParts = [relativeAge(oldest, nowMs), originSummary(waiting), stakesSummary(waiting)].filter(Boolean);
        const meta = metaParts.length ? `<p class="inbox-meta">${escapeText(metaParts.join(" · "))}</p>` : "";
        const items = waiting.map((c) => {
          const kind = KIND_SHORT[c.body.kind] ?? c.body.kind;
          const undo = UNDO_SHORT[c.body.stakes.reversibility] ?? c.body.stakes.reversibility;
          return `<li>${escapeText(c.body.question)} <span class="muted">(${escapeText(`${kind} · ${undo}`)})</span></li>`;
        }).join("");
        sections.push(`<article class="inbox-review"><h2>${escapeText(label)}</h2>${title}${meta}<ul>${items}</ul>
          <form method="post" action="/open/${encodeURIComponent(project.id)}/${encodeURIComponent(reviewId)}">
          <button type="submit">Open review</button></form></article>`);
      }
      for (const rec of engine.recentReviews(8)) {
        const waiters = waitersFor?.(project.id, rec.review_id) ?? [];
        const waiterLabel = waiters.length
          ? `agent waiting (${waiters.map((w) => w.session).join(", ")})`
          : rec.editable_count > 0 ? "editable before work begins" : undefined;
        const metaParts = [relativeAge(rec.updated_at, nowMs), waiterLabel].filter(Boolean);
        const rows = rec.cards.map((c) => {
          const effect = c.applied_evidence ? ` — Applied: ${c.applied_evidence.effect}` : "";
          const ans = c.answer_summary ? `: ${c.answer_summary}` : "";
          return `<li><strong>${escapeText(c.question)}</strong> <span class="badge">${escapeText(c.status.replaceAll("_", " "))}</span><span class="muted">${escapeText(`${ans}${effect}`)}</span></li>`;
        }).join("");
        const btnLabel = rec.editable_count > 0 ? "Edit or withdraw (before work begins)" : "View status &amp; effects";
        recentEntries.push({
          updatedAt: rec.updated_at,
          html: `<article class="recent-review"><h4>${escapeText(label)}${rec.task_title ? ` — ${escapeText(rec.task_title)}` : ""}</h4>
            ${metaParts.length ? `<p class="inbox-meta">${escapeText(metaParts.join(" · "))}</p>` : ""}
            <ul>${rows}</ul>
            <form method="post" action="/edit/${encodeURIComponent(project.id)}/${encodeURIComponent(rec.review_id)}">
            <button type="submit" class="button-secondary">${btnLabel}</button></form></article>`,
        });
      }
    }
    const empty = '<p class="empty"><span class="check" aria-hidden="true">✓</span>No questions are waiting.</p>';
    const recentHtml = recentEntries.length
      ? `<section class="recent-section" aria-label="Recent and in flight"><h3>Recent &amp; In Flight</h3>${recentEntries
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10).map((e) => e.html).join("")}</section>`
      : "";
    return sendHtml(res, 200, page("Review inbox", `<h1>Review inbox</h1>${historySearch()}
      ${pinSections.length ? pinForm("/") + pinSections.join("") : ""}${sections.join("") || empty}${recentHtml}`));
  }
  const open = /^\/open\/(prj-[a-f0-9]{12})\/(V-[A-Za-z0-9-]+)$/.exec(path);
  if (open && req.method === "POST") {
    if (req.headers.origin !== pages.origin.origin) return unavailable(403);
    const result = pages.prepare(open[1]!, actor, open[2], true);
    if (result.code !== EXIT.OK) return unavailable(result.code === EXIT.BUSY ? 503 : 409);
    res.writeHead(303, { location: new URL(String(result.url)).pathname, "cache-control": "no-store" });
    res.end();
    return;
  }
  const edit = /^\/edit\/(prj-[a-f0-9]{12})\/(V-[A-Za-z0-9-]+)$/.exec(path);
  if (edit && req.method === "POST") {
    if (req.headers.origin !== pages.origin.origin) return unavailable(403);
    const result = pages.prepareEdit(edit[1]!, actor, edit[2]);
    if (result.code !== EXIT.OK) return unavailable(result.code === EXIT.BUSY ? 503 : 409);
    res.writeHead(303, { location: new URL(String(result.url)).pathname, "cache-control": "no-store" });
    res.end();
    return;
  }
  unavailable(404);
}
