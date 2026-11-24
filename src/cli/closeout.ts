import { checkGoals } from "../core/check.js";
import { EXIT, type AcceptanceGoal, type OpResult } from "../core/types.js";
import { call, CliError } from "./client.js";
import { currentHookTurn, recordHookReport } from "./closeout-hook.js";
import { projectFor } from "./registry.js";
import { completionMarkdown, type RequestView } from "./render.js";

async function queuedNotices(): Promise<RequestView[] | null> {
  try {
    const { project } = projectFor();
    const options = { project, timeoutMs: 5000 };
    const status = await call("status", {}, options);
    if (status.code !== EXIT.OK) return null;
    const requests = status.requests as { id: string; revision: number; status: string; kind: string }[];
    const queued = requests.filter(r => r.status === "queued" && r.kind === "notice");
    const results = await Promise.all(queued.map(r => call("show", { id: `${r.id}@${r.revision}` }, options)));
    if (results.some(r => r.code !== EXIT.OK)) return null;
    return results.map(r => r.request as RequestView).filter(r => r.current && r.status === "queued");
  } catch (error) {
    if (error instanceof CliError || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "EACCES") return null;
    throw error;
  }
}

export async function closeout(input: Record<string, unknown>): Promise<OpResult> {
  const failures = checkGoals(input.goals);
  if (failures.length) return { code: EXIT.CHECK_FAILED, failures };
  const goals = input.goals as AcceptanceGoal[];
  if (goals.some(g => g.evidence.some(e => e.kind !== "observed" && e.kind !== "inferred"))) {
    return { code: EXIT.CHECK_FAILED, failures: [{ rule: "H03-evidence", message: "Mark each claim as observed or inferred.", waivable: false }] };
  }
  let turn: ReturnType<typeof currentHookTurn>;
  try { turn = currentHookTurn(); }
  catch { process.stderr.write("UTP could not read the optional Claude hook state.\n"); }
  const notices = await queuedNotices();
  const markdown = completionMarkdown(goals, notices);
  try { recordHookReport(turn, markdown); }
  catch { process.stderr.write("UTP could not save the report for the optional Claude hook.\n"); }
  return { code: EXIT.OK, goals, notices, markdown };
}
