import { lstatSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Engine } from "../core/engine.js";
import { EXIT } from "../core/types.js";
import { escapeText, page } from "./review-html.js";
import { answerable, ReviewPages, sendHtml } from "./review-page.js";
import type { Service } from "./service.js";

const actor = { machine: "review-inbox", session: "browser" };

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
    for (const project of service.projects()) {
      const engine = service.engine(project.id);
      if (!(engine instanceof Engine)) return unavailable(503);
      const status = engine.run("status", {}, actor);
      const groups = new Map<string, string[]>();
      for (const item of status.requests as Outstanding[]) {
        if (item.review_id === status.open_review || item.kind === "notice" || !answerable(item.status)) continue;
        const questions = groups.get(item.review_id) ?? [];
        questions.push(item.question);
        groups.set(item.review_id, questions);
      }
      for (const [review, questions] of groups) {
        const items = questions.map((q) => `<li>${escapeText(q)}</li>`).join("");
        sections.push(`<article><h2>${escapeText(project.name ?? project.id)}</h2><ul>${items}</ul>
          <form method="post" action="/open/${encodeURIComponent(project.id)}/${encodeURIComponent(review)}">
          <button type="submit">Open review</button></form></article>`);
      }
    }
    return sendHtml(res, 200, page("Review inbox", `<h1>Review inbox</h1>${sections.join("") || "<p>No questions are waiting.</p>"}`));
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
