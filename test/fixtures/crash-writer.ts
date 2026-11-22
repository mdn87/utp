// Test helper: opens a store and commits one operation, optionally dying at a
// named step of the write. Usage: crash-writer <dir> <op-id> [crash-point]
import { EventStore, type CrashPoint } from "../../src/core/store.js";

const [dir, opId, crashAt] = process.argv.slice(2);
if (!dir || !opId) throw new Error("usage: crash-writer <dir> <op-id> [crash-point]");
const store = new EventStore(dir, { crashAt: (crashAt || undefined) as CrashPoint | undefined });
store.open();
const event = store.append(
  { type: "test.write", at: new Date().toISOString(), op_id: opId, data: { n: 1 }, result: { ok: true, value: 42 } },
  { body: { hello: "world" } },
);
process.stdout.write(JSON.stringify(event.result));
store.close();
