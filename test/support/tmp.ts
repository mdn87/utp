// Temporary folders for tests. Each folder is removed when the test process
// exits, so a test run leaves nothing behind in the system temp folder.
// Set UTP_KEEP_TMP=1 to keep the folders for debugging.
import { mkdtempSync as makeTempFolder, rmSync } from "node:fs";

const created: string[] = [];

process.on("exit", () => {
  if (process.env.UTP_KEEP_TMP) return;
  for (const dir of created.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
    } catch {
      // Another process still holds a file open. Leave the folder behind.
    }
  }
});

/** Works like fs.mkdtempSync, and removes the folder when this process exits. */
export function mkdtempSync(prefix: string): string {
  const dir = makeTempFolder(prefix);
  created.push(dir);
  return dir;
}
