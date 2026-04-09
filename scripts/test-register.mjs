// Tiny `--import` shim that registers ./test-loader.mjs as a Node ESM
// resolver hook before any test code runs. Splitting the registration
// out from the loader itself is the post-Node-20.6 idiom (the older
// `--experimental-loader=…` form still works but logs a deprecation
// warning on every run).
//
// Used by `pnpm test` — see package.json.

import { register } from "node:module";

// `import.meta.url` is already a file:// URL string, which is exactly the
// shape `register()` expects as a parent URL — passing it through
// pathToFileURL would double-encode it.
register("./test-loader.mjs", import.meta.url);
