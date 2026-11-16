// Ratchet CLI: check results against .github/perf/ratchets.json, lower the
// ceilings after a win, or guard that a change did not raise one.
//
//   node .github/perf/ratchet.mjs check results.json [--prefix bundle.]
//   node .github/perf/ratchet.mjs lower results.json [--init --metrics a,b]
//   node .github/perf/ratchet.mjs guard base-ratchets.json head-ratchets.json
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  lower,
  guard,
  measurements,
  initialMetrics,
} from "./lib/ratchets.mjs";
const args = process.argv.slice(2),
  command = args.shift();
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const file = option(
  "--ratchets",
  fileURLToPath(new URL("./ratchets.json", import.meta.url)),
);
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
try {
  if (command === "guard") {
    const errors = guard(read(args[0]), read(args[1]));
    errors.forEach((e) => console.error(`FAIL ${e}`));
    if (!errors.length) console.log("PASS ratchet guard");
    process.exitCode = errors.length ? 1 : 0;
  } else if (command === "check" || command === "lower") {
    const measured = measurements(read(args[0]), option("--target", "head"));
    const ratchets = read(file);
    if (command === "lower") {
      const init = args.includes("--init")
        ? option("--metrics", initialMetrics.join(",")).split(",")
        : [];
      fs.writeFileSync(
        file,
        JSON.stringify(lower(ratchets, measured, init), null, 2) + "\n",
      );
    } else {
      const rows = check(ratchets, measured, option("--prefix", ""));
      console.table(rows);
      rows
        .filter((r) => r.canLower)
        .forEach((r) =>
          console.log(`LOWER ${r.key} can be lowered to ${r.value}`),
        );
      if (!rows.length)
        console.log(
          "UNINITIALIZED: no matching ceilings; run lower --init with an explicit metric list after a green run",
        );
      process.exitCode = rows.some((r) => !r.ok) ? 1 : 0;
    }
  } else
    throw new Error(
      "Usage: ratchet.mjs check|lower results.json [--prefix bundle.] [--init --metrics a,b] | guard base.json head.json",
    );
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exitCode = 1;
}
