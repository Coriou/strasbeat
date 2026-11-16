// Dedicated formatting thread. The entire static Prettier graph and quote
// restoration pipeline must build into one classic worker with no fetches.
import { formatBuffer } from "./format-core.js";

self.addEventListener("message", async ({ data: { id, code } }) => {
  try {
    const formatted = await formatBuffer(code);
    self.postMessage({ id, formatted });
  } catch (error) {
    // Send the full message, including Prettier's code frame. The page's
    // existing status reporter chooses the first line for the status bar.
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
});
