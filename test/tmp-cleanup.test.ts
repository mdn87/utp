import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The helper removes its folders when the process exits, so each case runs it
// in a child process and looks at the folder after that process has ended.
const helper = new URL("./support/tmp.js", import.meta.url).href;
const script = `import(${JSON.stringify(helper)}).then((m) => {
  const dir = m.mkdtempSync(process.argv[1]);
  require("node:fs").writeFileSync(require("node:path").join(dir, "file.txt"), "x");
  process.stdout.write(dir);
});`;

function makeFolderInChild(keep: string): string {
  const result = spawnSync(process.execPath, ["-e", script, path.join(tmpdir(), "utp-tmp-helper-")],
    { encoding: "utf8", env: { ...process.env, UTP_KEEP_TMP: keep } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(path.basename(result.stdout), /^utp-tmp-helper-/);
  return result.stdout;
}

test("a temporary folder made by a test is removed when the test process exits", () => {
  assert.equal(existsSync(makeFolderInChild("")), false);
});

test("UTP_KEEP_TMP keeps the folder for debugging", () => {
  const dir = makeFolderInChild("1");
  try {
    assert.equal(existsSync(path.join(dir, "file.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
