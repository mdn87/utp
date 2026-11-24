// Claude Code SessionStart hook: exports the active native session UUID as UTP_SESSION via CLAUDE_ENV_FILE.
import { appendFileSync, readFileSync } from "node:fs";

const UUID = new RegExp("^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$", "i");
const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) process.exit(0);
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (typeof input?.session_id === "string" && UUID.test(input.session_id)) {
    appendFileSync(envFile, `export UTP_SESSION=${input.session_id}\n`, "utf8");
  }
} catch {
  // Keep SessionStart non-blocking if stdin is empty or invalid.
}
