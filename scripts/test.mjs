// Runs the compiled tests with Node's built-in test runner.
// UTP_BUILD_DIR must match the folder the build wrote to (default: dist).
// Extra arguments are passed to node --test (for example a name pattern).
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(process.env.UTP_BUILD_DIR || "dist", "test");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".test.js")) files.push(full);
  }
};
walk(root);
if (files.length === 0) {
  console.error(`no compiled tests under ${root}; run the build first`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files.sort()], { stdio: "inherit" });
process.exit(result.status ?? 1);
