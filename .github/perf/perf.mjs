// The performance rig: measures the app's journeys in headless Chromium on a
// GitHub runner and writes out/results.json and out/summary.md. Run by
// .github/workflows/perf.yml; nothing here is run locally. What it measures
// and how to read it: docs/architecture.md, "Performance rig and ratchets".
//
//   node perf.mjs --head dist [--base base/dist] [--scenarios a,b]
//                 [--repeats N] [--mode ratchet] [--profile a] [--trace a]
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { fixtures, serve } from "./lib/server.mjs";
import { frameFlags } from "./lib/frames.mjs";
import { symbolicator } from "./lib/symbols.mjs";
import { summary } from "./lib/report.mjs";
import { bundle } from "./bundle.mjs";
import { Skip } from "./lib/browser.mjs";
const names = [
  "launch-cold",
  "launch-warm",
  "typing",
  "playing",
  "tabs",
  "eval",
  "idle",
  "memory",
];
// Run only when asked for by name.
const onDemand = ["sweep"];
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!/^--/.test(args[i]) || args[i + 1] == null)
    throw new Error(`Expected --option value: ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.head)
  throw new Error(
    "Usage: perf.mjs --head dist [--base base/dist] [--scenarios a,b] [--repeats N] [--mode ratchet] [--profile scenario] [--trace scenario] [--net-delay ms] [--out out]",
  );
const repeats = Number(options.repeats ?? 1),
  delay = Number(options["net-delay"] ?? 0),
  out = path.resolve(options.out ?? "out");
if (
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 10 ||
  !Number.isFinite(delay) ||
  delay < 0
)
  throw new Error("Invalid repeats or net delay");
const selected = options.scenarios?.split(",") ?? names;
if (selected.some((n) => !names.includes(n) && !onDemand.includes(n)))
  throw new Error("Unknown scenario");
if (options.mode && options.mode !== "ratchet") throw new Error("Unknown mode");
await fs.mkdir(out, { recursive: true });
const result = {
  schemaVersion: 1,
  runner: {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    platform: os.platform(),
    release: os.release(),
  },
  options,
  targets: {},
  records: [],
  started: new Date().toISOString(),
};
const fixture = fixtures(),
  servers = [],
  browsers = [];
let normal, controlled, gl;
async function browser(kind) {
  if (kind === "normal" && normal) return normal;
  if (kind === "controlled" && controlled) return controlled;
  if (kind === "gl" && gl) return gl;
  const b = await chromium.launch({
    args: [
      "--autoplay-policy=no-user-gesture-required",
      ...(kind === "normal" ? [] : frameFlags),
      ...(kind === "gl"
        ? [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
          ]
        : ["--disable-gpu"]),
    ],
  });
  browsers.push(b);
  if (kind === "normal") normal = b;
  else if (kind === "controlled") controlled = b;
  else gl = b;
  result.chromium = b.version();
  return b;
}
async function persist() {
  const md = summary(result);
  await fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(result, null, 2),
  );
  await fs.writeFile(path.join(out, "summary.md"), md);
}
try {
  await fixture.prepare();
  result.fixtures = await fixture.hashes();
  const targets =
    options.base && options.mode !== "ratchet" ? ["base", "head"] : ["head"];
  for (const target of targets) {
    const dir = path.resolve(options[target]);
    const html = await fs.readFile(path.join(dir, "index.html"));
    const bundled = await bundle(dir);
    for (const file of bundled.records[0].info.initial) {
      try {
        await fs.access(path.join(dir, file + ".map"));
      } catch {
        throw new Error(
          `Missing hidden source map: ${target}/${file}.map; build with --sourcemap hidden`,
        );
      }
    }
    result.records.push(
      ...bundled.records.map((r) => ({ ...r, target, repeat: 0 })),
    );
    const hasServiceWorker = await fs.access(path.join(dir, "sw.js")).then(
      () => true,
      () => false,
    );
    result.targets[target] = {
      directory: dir,
      hasServiceWorker,
      sha:
        options[`${target}-sha`] ??
        process.env[`${target.toUpperCase()}_SHA`] ??
        "unknown",
      buildId: createHash("sha256").update(html).digest("hex"),
    };
  }
  for (const name of selected) {
    const scenario = await import(`./scenarios/${name}.mjs`);
    for (const variant of scenario.variants) {
      if (
        options.mode === "ratchet" &&
        (variant === "cpu4" || name === "memory")
      )
        continue;
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const pass of options.mode === "ratchet"
          ? ["count"]
          : name === "memory"
            ? ["count"]
            : ["timing", "count"]) {
          if (name === "typing" && variant === "cpu4" && pass === "count")
            continue;
          // A/B repeats are adjacent within each pass, on the same runner.
          for (const target of targets) {
            const row = {
              scenario: name,
              description: scenario.description,
              variant,
              repeat,
              target,
              pass,
              status: "ok",
              counts: {},
              timings: {},
              info: {},
            };
            const visual =
              name === "playing" && ["hydra", "shader"].includes(variant);
            const run = async (kind) => {
              const server = await serve(
                options[target],
                fixture,
                variant === "net150" ? 150 : delay,
              );
              servers.push(server);
              const ctx = {
                target,
                scenario: name,
                variant,
                repeat,
                pass,
                counting: pass === "count",
                delay: variant === "net150" ? 150 : delay,
                out,
                server,
                fixture,
                symbols: symbolicator(options[target]),
                hasServiceWorker: result.targets[target].hasServiceWorker,
                browser: await browser(kind),
                contexts: new Set(),
                configuredContexts: new Set(),
                drivers: new Set(),
                unexpectedRequests: [],
                pageErrors: [],
                console: [],
                serial: 0,
                label: `${target}/${name}/${variant}/${repeat + 1}/${pass}/${kind}`,
                profile:
                  pass === "timing" &&
                  options.profile?.split(",").includes(name),
                trace:
                  pass === "timing" && options.trace?.split(",").includes(name),
                // For a scenario with no timing pass (memory) to act on.
                traceRequested: !!options.trace?.split(",").includes(name),
              };
              console.log(`STEP ${ctx.label}`);
              try {
                const r = await scenario.run(ctx);
                r.info = {
                  ...r.info,
                  unexpectedRequests: ctx.unexpectedRequests,
                  pageErrors: ctx.pageErrors,
                  console: ctx.console,
                  serverRequests: [...server.log],
                  browserKind: kind,
                };
                if (
                  ctx.unexpectedRequests.length ||
                  ctx.pageErrors.length ||
                  server.errors.length
                ) {
                  r.status = "error";
                  r.error = `Unexpected requests (${ctx.unexpectedRequests.length}), page errors (${ctx.pageErrors.length}), server errors (${server.errors.length}): ${[...ctx.unexpectedRequests, ...ctx.pageErrors, ...server.errors].join("; ")}`;
                }
                return r;
              } catch (e) {
                e.details = {
                  unexpectedRequests: ctx.unexpectedRequests,
                  pageErrors: ctx.pageErrors,
                  console: ctx.console,
                };
                throw e;
              } finally {
                for (const d of ctx.drivers)
                  await d
                    ?.stop()
                    .catch((e) =>
                      console.error(`FAIL pump cleanup: ${e.message}`),
                    );
                for (const c of ctx.contexts) await c.close();
                await server.close();
                servers.splice(servers.indexOf(server), 1);
              }
            };
            try {
              let measured;
              try {
                measured = await run(
                  [
                    "launch-cold",
                    "launch-warm",
                    "eval",
                    "idle",
                    "memory",
                  ].includes(name)
                    ? "normal"
                    : "controlled",
                );
              } catch (e) {
                if (!visual || e instanceof Skip) throw e;
                row.info.fallbackReason = e.message;
                measured = await run("gl");
              }
              if (
                visual &&
                measured.pacingValid === false &&
                measured.info.browserKind !== "gl"
              ) {
                const first = measured;
                measured = await run("gl");
                measured.info.softwareAttempt = first;
              }
              Object.assign(row, measured, {
                info: { ...row.info, ...measured.info },
              });
              // Not a failure of the build: this runner could not step the
              // variant at its rate, so the variant has no number. Whether
              // that matters is the ratchet check's call — a ceiling on a
              // window that did not hold pace fails there. Without this,
              // the heaviest variants, which are evidence only, failed the
              // whole run whenever the job landed on a slow machine.
              if (row.pacingValid === false) {
                row.status = "unpaced";
                row.reason =
                  "No measured window held pace within 1% after three attempts";
              }
            } catch (e) {
              row.status = e instanceof Skip ? "skipped" : "error";
              row.error = e.stack ?? e.message;
              row.reason = e.message;
              row.info = { ...row.info, ...e.details };
            }
            console.log(
              `${{ ok: "PASS", skipped: "SKIP", unpaced: "SLOW" }[row.status] ?? "FAIL"} ${target}/${name}/${variant}/${repeat + 1}/${pass}${row.error || row.reason ? ": " + (row.error ?? row.reason).split("\n")[0] : ""}`,
            );
            result.records.push(row);
            await persist();
          }
        }
      }
    }
  }
} catch (e) {
  result.error = e.stack ?? e.message;
  console.error(`FAIL ${result.error}`);
} finally {
  for (const b of browsers) await b.close();
  for (const s of servers) await s.close();
  result.finished = new Date().toISOString();
  await persist();
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      await fs.readFile(path.join(out, "summary.md")),
    );
}
process.exitCode =
  result.error || result.records.some((r) => r.status === "error") ? 1 : 0;
