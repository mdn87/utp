// Only the service operator selects transcript roots. Client requests carry a session ID,
// never a file path or a transcript. Only visible assistant text and person-typed turns survive.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Actor } from "../core/types.js";
import type { ChatTurn } from "../core/conversation.js";

export type TranscriptRoots = Record<string, { codex?: string; claude?: string }>;
export function transcriptRoots(value: Record<string, unknown>): TranscriptRoots {
  for (const settings of Object.values(value)) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)
        || !Object.entries(settings).every(([name, root]) => ["codex", "claude"].includes(name) && typeof root === "string" && path.isAbsolute(root))) {
      throw Error("Each transcript source needs native session directories with absolute paths for codex or claude.");
    }
  }
  return value as TranscriptRoots;
}
const sessionId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
type Row = { type?: string; sessionId?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean;
  sourceToolAssistantUUID?: string; origin?: { kind?: string }; promptSource?: string; turnOrigin?: string;
  userType?: string; parentUuid?: string | null; uuid?: string;
  message?: { role?: string; content?: unknown }; payload?: {
    type?: string; role?: string; content?: unknown; id?: string; turn_id?: string; thread_source?: unknown; source?: unknown;
    message?: string; phase?: string; recipient?: string; internal_chat_message_metadata_passthrough?: {
      turn_id?: string; content_item_kinds?: string[]; content_item_metadata?: { provenance?: { type?: string } }[] };
  } };

function plainText(blocks: unknown, type: string, strict: boolean): string | undefined {
  if (!Array.isArray(blocks) || (strict && blocks.some(b => b?.type !== type))) return;
  const parts = blocks.filter(b => b?.type === type && typeof b.text === "string").map(b => b.text);
  return parts.length ? parts.join("\n") : undefined;
}

async function directories(parent: string, match: RegExp): Promise<string[]> {
  return (await readdir(parent, { withFileTypes: true })).filter(e => e.isDirectory() && match.test(e.name)).map(e => path.join(parent, e.name));
}

async function sessionFiles(root: string, platform: "claude" | "codex", session: string): Promise<string[]> {
  const base = await realpath(root);
  let dirs = [base];
  for (const match of platform === "claude" ? [/./] : [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/]) {
    const next: string[] = [];
    for (const dir of dirs) next.push(...await directories(dir, match));
    dirs = next;
  }
  const matches: string[] = [];
  for (const dir of dirs) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const match = platform === "claude" ? e.name === session + ".jsonl"
        : e.name.startsWith("rollout-") && e.name.endsWith("-" + session + ".jsonl");
      if (e.isFile() && match) matches.push(path.join(dir, e.name));
    }
  }
  return matches;
}

export async function readNativeTurns(roots: TranscriptRoots, actor: Actor): Promise<ChatTurn[] | undefined> {
  if (!sessionId.test(actor.session) || !Object.hasOwn(roots, actor.machine)) return;
  try {
    const matches: { file: string; platform: "claude" | "codex" }[] = [];
    for (const platform of ["claude", "codex"] as const) {
      const root = roots[actor.machine]?.[platform];
      if (!root) continue;
      try {
        for (const file of await sessionFiles(root, platform, actor.session)) matches.push({ file, platform });
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    if (matches.length !== 1) return;
    const { file, platform } = matches[0]!;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const turns: ChatTurn[] = [];
    const parents = new Map<string, string | null>();
    const claudeNodes = new Map<string, string>();
    const codexUsers = new Map<string, { format: string; text: string }>();
    let leaf: string | undefined;
    let nativeTurn: string | undefined;
    let identity = false;
    let line = 0;
    try {
      for await (const text of lines) {
        line++;
        if (!text.trim()) continue;
        const row = JSON.parse(text) as Row;
        const p = row.payload;
        let role: ChatTurn["role"] | undefined;
        let content: string | undefined;
        if (platform === "codex") {
          if (row.type === "event_msg" && p?.type === "task_started") nativeTurn = p.turn_id;
          if (row.type === "session_meta") {
            if (p?.id !== actor.session || (p.thread_source && p.thread_source !== "user") || typeof p.source === "object") return;
            identity = true;
          }
          if (row.type === "response_item" && p?.type === "message" && p.role === "assistant" && (!p.recipient || p.recipient === "all")
              && (!p.phase || p.phase === "commentary" || p.phase === "final_answer")) {
            role = "assistant"; content = plainText(p.content, "output_text", false);
          } else if (row.type === "response_item" && p?.role === "user" && p.type === "message") {
            const meta = p.internal_chat_message_metadata_passthrough;
            if (!meta?.content_item_kinds?.length || !meta.content_item_kinds.every(k => k === "user.text")
                || meta.content_item_metadata?.length !== meta.content_item_kinds.length
                || !meta.content_item_metadata.every(m => m.provenance?.type === "user")) continue;
            role = "user"; content = plainText(p.content, "input_text", true);
          } else if (row.type === "event_msg" && p?.type === "user_message") {
            role = "user"; content = p.message;
          }
        } else {
          if (row.isSidechain || (row.sessionId && row.sessionId !== actor.session)) continue;
          if (row.uuid && (typeof row.parentUuid === "string" || row.parentUuid === null)) {
            parents.set(row.uuid, row.parentUuid);
            if (row.type === "user" || row.type === "assistant") leaf = row.uuid;
          }
          if (row.type !== "user" && row.type !== "assistant") continue;
          if (row.sessionId !== actor.session || row.isSidechain || row.isMeta || row.isCompactSummary || row.sourceToolAssistantUUID
              || (row.userType && row.userType !== "external") || row.message?.role !== row.type) continue;
          if (row.type === "user" && (row.origin ? row.origin.kind !== "human" : row.turnOrigin || row.promptSource)) continue;
          identity = true; role = row.type;
          const raw = row.message.content;
          content = typeof raw === "string" ? raw : plainText(raw, "text", role === "user");
          if (role === "user" && /^\s*<(?:local-command|command-name|system-reminder|task-notification|teammate-message)\b/i.test(content ?? "")) continue;
        }
        if (role && typeof content === "string" && content.trim()) {
          if (platform === "codex" && role === "user") {
            const turnId = p?.internal_chat_message_metadata_passthrough?.turn_id ?? p?.turn_id ?? nativeTurn;
            if (turnId) {
              const prior = codexUsers.get(turnId);
              if (prior && prior.format !== row.type && prior.text === content) continue;
              codexUsers.set(turnId, { format: row.type!, text: content });
            }
          }
          const id = createHash("sha256").update(platform + ":" + line + ":" + text).digest("hex");
          if (platform === "claude" && row.uuid) claudeNodes.set(id, row.uuid);
          turns.push({ id, role, text: content.replace(/\r\n/g, "\n") });
        }
      }
    } finally { lines.close(); stream.destroy(); }
    if (!identity) return;
    if (!leaf) return turns;
    const active = new Set<string>();
    for (let node: string | null | undefined = leaf; node; node = parents.get(node)) {
      if (active.has(node)) return;
      active.add(node);
    }
    return turns.filter(t => active.has(claudeNodes.get(t.id) ?? ""));
  } catch { return undefined; }
}
