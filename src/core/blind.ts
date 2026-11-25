import type { RequestBody, RequestPreview } from "./types.js";

export type BlindArtifact = { text: string } | { media_type: "image/png" | "video/mp4"; data: string };

export interface BlindCandidate {
  identity: string;
  artifact: BlindArtifact;
  reveal_note?: string;
}

export interface BlindComparison {
  candidates: [BlindCandidate, BlindCandidate];
  recommended_candidate?: 0 | 1;
}

export interface BlindReveal {
  identities: { a: string; b: string };
  notes?: { a?: string; b?: string };
  recommendation?: "a" | "b";
}

export const BALLOT_OPTIONS = [
  { id: "a", label: "Candidate A", consequence: "Record A as your preference." },
  { id: "b", label: "Candidate B", consequence: "Record B as your preference." },
  { id: "tie", label: "Tie", consequence: "Record equal preference." },
  { id: "neither", label: "Neither", consequence: "Record that neither candidate is usable." },
  { id: "skip", label: "Skip", consequence: "Record that you left this comparison undecided." },
];

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imageChunks = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const videoContainers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "moof", "traf"]);
const videoMetadata = new Set(["udta", "meta", "uuid", "free", "skip", "cprt", "XMP_", "auth", "titl", "dscp", "perf", "gnre", "yrrc", "albm", "kywd", "loci", "url ", "urn "]);
const visualSampleEntries = new Set(["avc1", "avc3", "hvc1", "hev1", "mp4v", "av01", "vp09"]);

function anonymousPng(data: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.subarray(0, 8).equals(signature)) return undefined;
  const chunks = [signature];
  let hasPixels = false;
  for (let start = 8; start + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(start);
    const end = start + 12 + size;
    if (end > bytes.length) return undefined;
    const type = bytes.toString("ascii", start + 4, start + 8);
    if (start === 8 && (type !== "IHDR" || size !== 13)) return undefined;
    if (type === "IDAT") hasPixels = true;
    // Keep only the chunks needed to display the image, without author metadata.
    if (imageChunks.has(type)) chunks.push(bytes.subarray(start, end));
    if (type === "IEND") return size === 0 && hasPixels ? Buffer.concat(chunks).toString("base64") : undefined;
    start = end;
  }
  return undefined;
}

function anonymousMp4(data: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  const bytes = Buffer.from(data, "base64");
  const topLevel = new Set<string>();
  const strip = (first: number, end: number, depth: number): boolean => {
    if (depth > 12) return false;
    for (let start = first; start < end;) {
      if (start + 8 > end) return false;
      const size32 = bytes.readUInt32BE(start);
      const type = bytes.toString("latin1", start + 4, start + 8);
      const header = size32 === 1 ? 16 : 8;
      if (start + header > end) return false;
      const size = size32 === 1 ? Number(bytes.readBigUInt64BE(start + 8)) : size32 || end - start;
      if (size < header || size > end - start) return false;
      if (depth === 0) topLevel.add(type);
      if (videoMetadata.has(type)) {
        // Keep sample offsets while clearing metadata.
        bytes.write("free", start + 4, 4, "latin1");
        bytes.fill(0, start + header, start + size);
      } else if (videoContainers.has(type) && !strip(start + header, start + size, depth + 1)) {
        return false;
      } else if ((type === "dref" || type === "stsd") && size > header + 8) {
        // Both dref and stsd have an 8-byte version+flags+entryCount header before child boxes.
        if (!strip(start + header + 8, start + size, depth + 1)) return false;
      } else if (visualSampleEntries.has(type) && size >= header + 82) {
        // Clear the 32-byte compressorname field inside visual sample entries without moving sample offsets.
        bytes.fill(0, start + header + 50, start + header + 82);
      } else if (type === "hdlr" && size > header + 24) {
        bytes.fill(0, start + header + 24, start + size);
      }
      start += size;
    }
    return true;
  };
  return strip(0, bytes.length, 0) && ["ftyp", "moov", "mdat"].every((type) => topLevel.has(type))
    ? bytes.toString("base64") : undefined;
}

function anonymousArtifact(artifact: unknown): BlindArtifact | undefined {
  if (!artifact || typeof artifact !== "object") return undefined;
  const a = artifact as Record<string, unknown>;
  if (typeof a.text === "string" && a.text.trim()) return { text: a.text };
  if (typeof a.data !== "string" || (a.media_type !== "image/png" && a.media_type !== "video/mp4")) return undefined;
  const data = a.media_type === "image/png" ? anonymousPng(a.data) : anonymousMp4(a.data);
  return data ? { media_type: a.media_type, data } : undefined;
}

export function normalizeBlind(value: unknown): BlindComparison | string {
  if (!value || typeof value !== "object") return "add two blind candidates";
  const raw = value as Partial<BlindComparison>;
  if (!Array.isArray(raw.candidates) || raw.candidates.length !== 2) return "add exactly two blind candidates";
  const candidates: BlindCandidate[] = [];
  for (const candidate of raw.candidates) {
    if (!candidate || typeof candidate.identity !== "string" || !candidate.identity.trim()) {
      return "each candidate needs a private identity to reveal after the ballot";
    }
    const artifact = anonymousArtifact(candidate.artifact);
    if (!artifact) return "each candidate needs nonempty text, a base64 PNG or a base64 MP4";
    if (candidate.reveal_note !== undefined && typeof candidate.reveal_note !== "string") return "reveal_note must be text";
    candidates.push({ identity: candidate.identity.trim(), artifact,
      ...(candidate.reveal_note?.trim() ? { reveal_note: candidate.reveal_note.trim() } : {}) });
  }
  const [first, second] = candidates as [BlindCandidate, BlindCandidate];
  if (JSON.stringify(first.artifact) === JSON.stringify(second.artifact)) return "the two candidate previews are identical";
  const rec = raw.recommended_candidate;
  if (rec !== undefined && rec !== 0 && rec !== 1) return "recommended_candidate must be 0 or 1";
  return { candidates: [first, second], ...(rec !== undefined ? { recommended_candidate: rec } : {}) };
}

export function exposesBlindIdentity(body: Partial<RequestBody>, blind: BlindComparison): boolean {
  const origin = body.origin && typeof body.origin === "object" ? Object.values(body.origin) : [];
  const basisFiles = Array.isArray(body.basis?.files) ? body.basis.files : [];
  const visible = [body.id, body.question, body.summary, body.why_now, body.level_reason,
    ...origin, ...basisFiles,
    ...[body.tags, body.related, body.depends_on].flatMap((items) => Array.isArray(items) ? items : []),
    ...blind.candidates.map(({ artifact }) => "text" in artifact ? artifact.text : undefined)];
  return blind.candidates.some(({ identity }) => {
    const escaped = identity.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    return visible.some((field) => typeof field === "string" && match.test(field));
  });
}

export function publicJudgment(body: RequestBody, swapped: boolean): RequestBody {
  const { id, question, summary, why_now, level, level_reason, stakes, tags, related, depends_on, origin } = body;
  const [first, second] = body.blind!.candidates;
  const ordered = swapped ? [second, first] : [first, second];
  const previews: RequestPreview[] = ordered.map(({ artifact }, i) => ({ ...artifact, label: i ? "Candidate B" : "Candidate A" }));
  const textOnly = (items?: string[]): string[] | undefined => Array.isArray(items)
    ? items.filter((item) => typeof item === "string") : undefined;
  const safeOrigin = origin && typeof origin === "object"
    ? {
      ...(typeof origin.platform === "string" && origin.platform.trim() ? { platform: origin.platform } : {}),
      ...(typeof origin.agent === "string" && origin.agent.trim() ? { agent: origin.agent } : {}),
    }
    : undefined;
  return {
    ...(typeof id === "string" && id.trim() ? { id } : {}),
    kind: "judge", question, summary, why_now, level, level_reason,
    stakes: { reversibility: stakes.reversibility },
    tags: textOnly(tags), related: textOnly(related), depends_on: textOnly(depends_on),
    ...(safeOrigin && Object.keys(safeOrigin).length ? { origin: safeOrigin } : {}),
    previews, options: BALLOT_OPTIONS,
  };
}

export function revealJudgment(comparison: BlindComparison, swapped: boolean): BlindReveal {
  const [first, second] = comparison.candidates;
  const [a, b] = swapped ? [second, first] : [first, second];
  const rec = comparison.recommended_candidate;
  return {
    identities: { a: a.identity, b: b.identity },
    ...(a.reveal_note || b.reveal_note ? { notes: { a: a.reveal_note, b: b.reveal_note } } : {}),
    ...(rec === undefined ? {} : { recommendation: (rec === 0) !== swapped ? "a" : "b" }),
  };
}
