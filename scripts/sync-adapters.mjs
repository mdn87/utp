// Keeps the canonical workflow reference copied into each self-contained platform adapter folder.
// Run with --check in CI or tests to fail on drift without modifying files.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "adapters", "utp-workflow.md");
const platforms = ["claude", "codex", "antigravity"];
const checkOnly = process.argv.includes("--check");

const expected = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const drifted = [];

for (const platform of platforms) {
  const dir = path.join(root, "adapters", platform);
  const target = path.join(dir, "utp-workflow.md");
  let actual;
  try {
    actual = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  } catch {
    actual = undefined;
  }
  if (actual === expected) continue;
  if (checkOnly) {
    drifted.push(path.relative(root, target));
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, expected, "utf8");
  }
}

if (checkOnly) {
  if (drifted.length) {
    console.error(`Adapter workflow copies are out of sync with adapters/utp-workflow.md:\n${drifted.map((f) => `- ${f}`).join("\n")}\nRun: node scripts/sync-adapters.mjs`);
    process.exit(1);
  }
  console.log(`All ${platforms.length} platform adapter copies match adapters/utp-workflow.md.`);
} else {
  console.log(`Synced adapters/utp-workflow.md to ${platforms.length} platform adapter folders.`);
}
