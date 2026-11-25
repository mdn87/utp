import { lstatSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RequestView, ReviewView } from "../cli/render.js";
import { validTaskTitle } from "../core/check.js";
import { Engine } from "../core/engine.js";
import { EXIT } from "../core/types.js";
import { escapeText, page } from "./review-html.js";
import { answerable, ReviewPages, sendHtml } from "./review-page.js";
import { normalizeRemote, type ProjectInfo, type Service } from "./service.js";

const actor = { machine: "review-inbox", session: "browser" };

const KIND_SHORT: Record<string, string> = {
  choose: "choice", approve: "approval", handoff: "manual step", clarify: "clarify",
  accept: "result check", assumptions: "assumptions", notice: "notice",
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
  readBody: (req: IncomingMessage) => Promise<string | undefined>): Promise<void> {
  const unavailable = (code: number) => sendHtml(res, code, page("Review unavailable", "<h1>Review unavailable</h1>"));
  if (req.headers.host?.toLowerCase() !== pages.origin.host) return unavailable(403);
  const path = req.url ?? "";
  if (path.startsWith("/review/")) return pages.handle(req, res, readBody);
  if (path === "/" && req.method === "GET") {
    const sections: string[] = [];
    const nowMs = Date.now();
    for (const project of service.projects()) {
      const engine = service.engine(project.id);
      if (!(engine instanceof Engine)) return unavailable(503);
      const status = engine.run("status", {}, actor);
      const openReviews = new Set((status.open_reviews as string[] | undefined) ?? (status.open_review ? [status.open_review as string] : []));
      const groups = new Map<string, Outstanding[]>();
      for (const item of status.requests as Outstanding[]) {
        if (openReviews.has(item.review_id) || item.kind === "notice" || !answerable(item.status)) continue;
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
        sections.push(`<article class="inbox-review"><h2>${escapeText(inboxLabel(project))}</h2>${title}${meta}<ul>${items}</ul>
          <form method="post" action="/open/${encodeURIComponent(project.id)}/${encodeURIComponent(reviewId)}">
          <button type="submit">Open review</button></form></article>`);
      }
    }
    const empty = '<p class="empty"><span class="check" aria-hidden="true">✓</span>No questions are waiting.</p>';
    return sendHtml(res, 200, page("Review inbox", `<h1>Review inbox</h1>${sections.join("") || empty}`));
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
  unavailable(404);
}
