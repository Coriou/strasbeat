// Journey: repeat launch — HTTP cache warm and, when the build has one, the
// service worker installed and in control. See launch-cold.mjs.
import { launch } from "./launch-cold.mjs";
export const name = "launch-warm";
export const description =
  "Second or third navigation in the same context, closing and reopening a page; same endpoints as cold launch.";
export const variants = ["second", "third"];
export const run = (ctx) => launch(ctx, ctx.variant === "third" ? 2 : 1);
