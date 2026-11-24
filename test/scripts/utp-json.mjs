// Small cross-shell helper for Tier A lifecycle scripts (lifecycle.sh / lifecycle.ps1).
// Avoids jq/python dependencies and keeps all JSON creation/parsing in UTF-8 files.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [cmd, ...args] = process.argv.slice(2);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function getPath(obj, dotPath) {
  let cur = obj;
  for (const part of dotPath.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

async function postControl(controlUrl, endpoint, payload) {
  const res = await fetch(`${controlUrl}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`control ${endpoint} failed (${res.status}): ${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}

if (cmd === "get") {
  const [file, field] = args;
  const val = getPath(readJson(file), field);
  process.stdout.write(val === undefined || val === null ? "" : String(val));
} else if (cmd === "write-fixtures") {
  const [dir, expiresAt] = args;
  const special = "Operator's \"quoted\" café — 日本語";
  const write = (name, obj, crlf = false) => {
    const raw = JSON.stringify(obj, null, 2) + "\n";
    writeFileSync(path.join(dir, name), crlf ? raw.replace(/\n/g, "\r\n") : raw, "utf8");
  };
  const auth = { action: "write", target: "target.txt", scope: "one fixture" };
  const authPair = { action: "write", target: "pair.txt", scope: "item-1, item-2" };

  write("consider-routine.json", {
    category: "formatting",
    level: 0,
    reason: `Routine formatting check (${special}).`,
  }, true);

  write("decide-choose.json", {
    category: "approach",
    level: 2,
    tags: ["adapter-suite"],
    body: {
      kind: "choose",
      category: "approach",
      question: `Which parser mode for ${special}?`,
      why_now: "The cross-shell suite checks file payloads with quotes and international text.",
      options: [
        { id: "a", label: "Strict", consequence: "Validate every row.", authorization: auth },
        { id: "b", label: "Lenient", consequence: "Skip malformed rows.", authorization: auth },
      ],
      recommendation: { option: "a", because: "Catches errors early.", preserves: "Data integrity.", bolder_alternative: "Accept malformed rows." },
      stakes: { reversibility: "easy" },
      level: 2,
      level_reason: "Reversible local parser setting.",
      basis: { files: ["target.txt"] },
    },
  }, true);

  write("intent.json", {
    asked: `Verify ${special} across shells.`,
    doing: "Exercise the full UTP CLI lifecycle.",
    scope_delta: "none",
  }, true);

  write("evidence-auth.json", {
    ...auth,
    effect: `Applied ${special}\r\nwith CRLF and LF.\n`,
  }, true);

  write("card-clarify.json", {
    kind: "choose",
    category: "approach",
    question: "Which output encoding should the report use?",
    why_now: "The report writer needs an encoding.",
    glossary: { "UTF-8": "Unicode text encoding", ASCII: "Basic English character encoding" },
    options: [
      { id: "a", label: "UTF-8", consequence: "Supports café and 日本語.", authorization: auth },
      { id: "b", label: "ASCII", consequence: "Drops accented characters.", authorization: auth },
    ],
    stakes: { reversibility: "easy" },
    level: 2,
    level_reason: "Output encoding is easy to change.",
    basis: { files: ["target.txt"] },
  });

  write("card-clarify-v2.json", {
    kind: "choose",
    category: "approach",
    question: "Which output encoding should the report use (UTF-8 preserves café and 日本語)?",
    why_now: "Clarified how each option handles accented and Japanese text.",
    glossary: { "UTF-8": "Unicode text encoding", ASCII: "Basic English character encoding" },
    options: [
      { id: "a", label: "UTF-8", consequence: "Preserves café, —, and 日本語 verbatim.", authorization: auth },
      { id: "b", label: "ASCII", consequence: "Replaces international characters.", authorization: auth },
    ],
    stakes: { reversibility: "easy" },
    level: 2,
    level_reason: "Output encoding is easy to change.",
    basis: { files: ["target.txt"] },
  });

  write("clarify-answer.json", {
    note: "Explain what happens to café and 日本語 under each choice.",
  });

  write("card-default.json", {
    kind: "choose",
    category: "approach",
    question: "Which fixture mode should the default run use?",
    why_now: "Needs a reversible local mode.",
    options: [
      { id: "a", label: "Strict", consequence: "Use strict mode.", authorization: auth },
      { id: "b", label: "Lenient", consequence: "Use lenient mode.", authorization: auth },
    ],
    default: {
      option: "a",
      consequence: "Use strict mode for now.",
      eligibility: {
        local: true,
        scope_delta: "none",
        undo: "Rewrite target.txt in one edit.",
        authority: "The person asked for a fixture update.",
        size: "small",
      },
    },
    stakes: { reversibility: "easy" },
    level: 2,
    level_reason: "Single local edit.",
    basis: { files: ["target.txt"] },
  });

  write("card-expire.json", {
    kind: "choose",
    category: "approach",
    question: "Keep the temporary cache warm?",
    why_now: "This offer expires after five minutes.",
    expires_at: expiresAt,
    options: [
      { id: "a", label: "Warm", consequence: "Keep the cache.", authorization: auth },
      { id: "b", label: "Drop", consequence: "Clear the cache." },
    ],
    stakes: { reversibility: "easy" },
    level: 2,
    level_reason: "Easy to rebuild.",
    basis: { files: ["target.txt"] },
  });

  write("card-partial.json", {
    kind: "choose",
    category: "approach",
    question: "Update both fixture items?",
    why_now: "Both items need updating.",
    options: [
      { id: "a", label: "Update both", consequence: "Writes item-1 and item-2.", authorization: authPair },
      { id: "b", label: "Skip", consequence: "Leaves pair.txt untouched." },
    ],
    stakes: { reversibility: "easy" },
    level: 2,
    level_reason: "Reversible local file update.",
    basis: { files: ["pair.txt"] },
  });

  write("evidence-not-performed.json", {
    note: "Checked workspace: target.txt is unchanged.",
  });

  write("evidence-partial.json", {
    note: "Only item-1 was written before lease expired.",
    remaining_scope: "item-2",
  });

  write("evidence-partial-finish.json", {
    action: "write",
    target: "pair.txt",
    scope: "item-2",
    effect: "Finished writing item-2.",
  });

  write("card-approve.json", {
    kind: "approve",
    question: "Publish the signed release archive?",
    why_now: "Publishing reaches outside the local checkout.",
    narrowing_reason: "The release archive publishes as one unit.",
    evidence: [
      { claim: "All build checks passed locally.", kind: "observed", source: "CI build log", date: "2026-11-23" },
    ],
    options: [
      {
        id: "yes",
        label: "Publish archive",
        consequence: "Publishes the signed archive externally.",
        authorization: { action: "publish", target: "release-archive", scope: "v1.0", expected_effect: "Archive is published." },
      },
      { id: "no", label: "Hold locally", consequence: "Nothing is published." },
    ],
    stakes: { reversibility: "one_way" },
    level: 3,
    level_reason: "Publishing cannot be undone.",
    basis: { files: ["target.txt"] },
  });

  write("evidence-approve.json", {
    action: "publish",
    target: "release-archive",
    scope: "v1.0",
    effect: "Published v1.0 archive.",
  });

  writeFileSync(path.join(dir, "quote-exact.txt"), "yes\r\n", "utf8");
  writeFileSync(path.join(dir, "quote-altered.txt"), "yes please\n", "utf8");
  writeFileSync(path.join(dir, "quote-partial.txt"), "ye\n", "utf8");
} else if (cmd === "write-authority") {
  const [file, decisionId] = args;
  writeFileSync(file, JSON.stringify({
    level: 2,
    category: "approach",
    tags: ["adapter-suite"],
    authority: {
      decision_id: decisionId,
      authorization: { action: "write", target: "target.txt", scope: "one fixture" },
    },
    body: {
      kind: "notice",
      question: "Reused existing parser mode approval.",
      why_now: "Matches the already approved scope.",
      stakes: { reversibility: "easy" },
      level: 1,
      level_reason: "Covered by prior authorization.",
    },
  }, null, 2) + "\n", "utf8");
} else if (cmd === "append-record") {
  const [logFile, scenario, step, code, detail] = args;
  const row = {
    scenario,
    step,
    code: Number(code),
    ...(detail ? { detail } : {}),
  };
  appendFileSync(logFile, JSON.stringify(row) + "\n", "utf8");
} else if (cmd === "advance") {
  const [controlUrl, ms] = args;
  await postControl(controlUrl, "/advance", { ms: Number(ms) });
} else if (cmd === "transcript") {
  const [controlUrl, platform, session, role, textFile] = args;
  const text = readFileSync(textFile, "utf8");
  await postControl(controlUrl, "/transcript", { platform, session, role, text });
} else if (cmd === "browser-answer") {
  const [controlUrl, url, value] = args;
  const r = await postControl(controlUrl, "/browser-answer", { url, value });
  process.stdout.write(String(r.status ?? ""));
} else if (cmd === "has-text") {
  const [file, needle] = args;
  const text = readFileSync(file, "utf8");
  process.stdout.write(text.includes(needle) ? "yes" : "no");
} else {
  console.error(`unknown helper cmd: ${cmd}`);
  process.exit(1);
}
