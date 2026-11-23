import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DeliveryAdapter, ReportInboxItem } from "./delivery-adapter.js";
import type { NoticeDigest } from "./engine.js";
import { redactText } from "./redact.js";

/** Publish an item for the existing morning report consumer. */
export function writeNoticeDigest(dir: string, project: string, digest: NoticeDigest, format?: DeliveryAdapter["formatInboxItem"]): void {
  if (digest.notices.length === 0) return;
  if (!/^prj-[0-9a-f]{12}$/.test(project) || !/^V-\d{8}-[0-9a-f]{8}$/.test(digest.review)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(digest.at)) {
    throw new Error("the notice digest has an invalid review or timestamp");
  }
  const stamp = digest.at.slice(0, 19).replaceAll(/[-:]/g, "") + "Z";
  const suffix = createHash("sha256").update(project + ":" + digest.review).digest("hex").slice(0, 6);
  const name = `${stamp}--utp--notices-${digest.review.toLowerCase()}--${suffix}.json`;
  const target = path.join(dir, name);
  if (existsSync(target) || existsSync(path.join(dir, "archive", digest.at.slice(0, 7), name))) return;
  const staging = path.join(dir, ".tmp");
  mkdirSync(staging, { recursive: true });
  const temp = path.join(staging, `${name}-${randomBytes(6).toString("hex")}`);
  const body_md = digest.notices.map(({ title, consequence }) => `- ${redactText(title)}\n\n  ${redactText(consequence)}`).join("\n\n");
  const item: ReportInboxItem = { schema: "utp-report-notice/v1", created: digest.at, title: "UTP review notices",
    body_md, review_id: digest.review };
  const output = format ? format(item) : item;
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("the report adapter must return an inbox object");
  writeFileSync(temp, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  try {
    // Linking the fully written file publishes it atomically without replacing an existing item.
    linkSync(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
}
