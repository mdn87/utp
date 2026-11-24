// Public fixtures and exported decision records must pass the generic check.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(name) : entry.isFile() ? [name] : [];
  });
}

const paths = [
  ...filesUnder("adapters"),
  ...filesUnder("test/fixtures"),
  ...filesUnder("docs/decisions").filter((name) => /\.(?:answers|export)\.json$/.test(name)),
];
const cli = path.resolve(process.env.UTP_BUILD_DIR || "dist", "src", "cli", "main.js");
const result = spawnSync(process.execPath, [cli, "leak-check", "--generic", ...paths], { stdio: "inherit" });
process.exit(result.status ?? 1);
