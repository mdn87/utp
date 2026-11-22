// Compiles the TypeScript sources.
// UTP_BUILD_DIR moves the output (default: dist). UTP_TOOLING_DIR points at a
// folder whose node_modules holds typescript and @types/node, for checkouts in
// synced or backed-up folders that should not hold node_modules themselves.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const outDir = process.env.UTP_BUILD_DIR || "dist";
const tooling = process.env.UTP_TOOLING_DIR;
const tsc = tooling
  ? path.join(tooling, "node_modules", "typescript", "bin", "tsc")
  : createRequire(import.meta.url).resolve("typescript/bin/tsc");
const args = [tsc, "-p", ".", "--outDir", outDir, ...process.argv.slice(2)];
if (tooling) args.push("--typeRoots", path.join(tooling, "node_modules", "@types"));
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
