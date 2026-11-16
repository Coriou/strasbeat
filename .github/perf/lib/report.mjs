// results.json → summary.md: one table per journey (base, head, change),
// the profiles and top-call tables, and the correlation evidence that says
// which counts moved together with wall-clock time in this run.
import { flatten } from "./ratchets.mjs";
import { stats, paired, pearson } from "./stats.mjs";
const fmt = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 });
const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");
export function summary(results) {
  const lines = [
    "# Performance lab",
    "",
    "Counts are candidates, not proof of speed. Timings use separate passes. Shared-runner timings are not gates.",
    "",
    `Runner: ${results.runner?.cpu}; ${results.runner?.cores} cores; Chromium ${results.chromium}`,
    "",
  ];
  const records = results.records;
  for (const scenario of [...new Set(records.map((r) => r.scenario))]) {
    lines.push(
      `## ${scenario}`,
      "",
      records.find((r) => r.scenario === scenario).description ?? "",
      "",
      "| Variant / metric | Base median (spread) | Head median (spread) | Δ % | Paired Δ median (spread) |",
      "|---|---:|---:|---:|---:|",
    );
    const subset = records.filter((r) => r.scenario === scenario);
    for (const variant of [...new Set(subset.map((r) => r.variant))])
      for (const kind of ["counts", "timings"]) {
        const rs = subset.filter(
          (r) =>
            r.variant === variant &&
            r.status === "ok" &&
            r.pass === (kind === "counts" ? "count" : "timing"),
        );
        const keys = [
          ...new Set(rs.flatMap((r) => Object.keys(flatten(r[kind])))),
        ];
        for (const key of keys) {
          if (/^groupsPerKey\.|\.spread$|\.n$/.test(key)) continue;
          const values = (target) =>
            rs
              .filter((r) => r.target === target)
              .sort((a, b) => a.repeat - b.repeat)
              .map((r) => flatten(r[kind])[key])
              .filter(Number.isFinite);
          const b = values("base"),
            h = values("head"),
            p = paired(b, h);
          const show = (a) =>
            a.n
              ? `${fmt(a.median)} (${a.spread == null ? "—" : fmt(a.spread * 100) + "%"})`
              : "—";
          lines.push(
            `| ${cell(variant + " / " + kind + "." + key)} | ${show(p.base)} | ${show(p.head)} | ${p.base.median && p.head.median != null ? fmt((p.head.median / p.base.median - 1) * 100) : "—"} | ${show(p.differences)} |`,
          );
        }
      }
    for (const r of subset) {
      if (r.status !== "ok" || r.pacingValid === false)
        lines.push(
          "",
          `**${r.target}/${r.variant}/${r.pass}/${r.repeat}: ${r.status}** ${cell(r.error ?? r.reason ?? "pace invalid")}`,
        );
      if (r.info?.attempts)
        lines.push(
          "",
          `${r.target}/${r.variant}/${r.repeat}/${r.pass} windows: ${r.info.attempts.map((a) => `${fmt(a.calls)} calls, ${fmt(a.wall)} ms, pace ${a.valid}`).join("; ")}`,
        );
      if (r.info?.heapGrowth) {
        lines.push(
          "",
          `### ${r.target}/${r.variant} heap growth over ${r.info.heapGrowth.cycles} evaluate/stop cycles, by kind`,
          "",
          "| Kind | Objects | Bytes | Bytes per cycle |",
          "|---|---:|---:|---:|",
        );
        for (const k of r.info.heapGrowth.kinds)
          lines.push(
            `| ${cell(k.kind)} | ${fmt(k.count)} | ${fmt(k.bytes)} | ${fmt(k.bytes / r.info.heapGrowth.cycles)} |`,
          );
      }
      if (r.info?.profile) {
        lines.push(
          "",
          `### ${r.target}/${r.variant}/${r.repeat} CPU self time`,
          "",
          "| Group | Self ms |",
          "|---|---:|",
        );
        for (const [k, v] of Object.entries(r.info.profile.groups).sort(
          (a, b) => b[1] - a[1],
        ))
          lines.push(`| ${cell(k)} | ${fmt(v)} |`);
        lines.push(
          "",
          "| Function / source | Self ms | % | Source line |",
          "|---|---:|---:|---|",
        );
        for (const f of r.info.profile.top)
          lines.push(
            `| ${cell(`${f.name} ${f.file}:${f.line}`)} | ${fmt(f.ms)} | ${fmt(f.percent)} | ${cell(f.snippet)} |`,
          );
      }
      if (
        r.info?.top &&
        (r.scenario === "playing" ||
          r.scenario === "typing" ||
          results.options.profile?.includes(r.scenario))
      ) {
        lines.push(
          "",
          `### ${r.target}/${r.variant}/${r.repeat} top calls`,
          "",
          "| Function / source | Calls | Source line |",
          "|---|---:|---|",
        );
        for (const f of r.info.top)
          lines.push(
            `| ${cell(`${f.name} ${f.file}:${f.line}`)} | ${fmt(f.count)} | ${cell(f.snippet)} |`,
          );
      }
    }
  }
  lines.push(
    "",
    "## Correlation evidence",
    "",
    "Each point pairs an uninstrumented timing pass with the count pass for the same target, variant and repeat. Dose, mode and A/B variation are observational evidence, not causal attribution. Invalid pacing is excluded.",
    "",
  );
  const pointsByMetric = new Map();
  for (const r of records.filter(
    (r) => r.pass === "count" && r.status === "ok" && r.pacingValid !== false,
  )) {
    const t = records.find(
      (t) =>
        t.pass === "timing" &&
        t.status === "ok" &&
        t.pacingValid !== false &&
        t.scenario === r.scenario &&
        t.variant === r.variant &&
        t.target === r.target &&
        t.repeat === r.repeat,
    );
    if (!t) continue;
    const times = flatten(t.timings);
    for (const [metric, value] of Object.entries(flatten(r.counts))) {
      if (
        !Number.isFinite(value) ||
        /heap|listeners|nodes|unused|server/i.test(metric)
      )
        continue;
      let partner = r.scenario === "playing" ? "scriptMsPerSecond" : "scriptMs";
      if (/network|requests/i.test(metric))
        partner = metric.startsWith("interactive.")
          ? "interactive"
          : r.scenario === "eval"
            ? "delayMs"
            : "ready";
      else if (r.scenario === "tabs")
        partner = metric.startsWith("firstOpen.")
          ? "firstOpen.scriptMs"
          : "switch.scriptMs";
      else if (r.scenario === "idle") partner = "taskMs";
      const time = times[partner];
      if (!Number.isFinite(time)) continue;
      // Opening a tab and switching to one are the same kind of operation
      // at two sizes: together they are four points, apart two each.
      const family =
        r.scenario === "tabs"
          ? `tabs.${metric.replace(/^(firstOpen|switch)\./, "*.")} ↔ *.scriptMs`
          : `${r.scenario}.${metric} ↔ ${partner}`;
      const key = family,
        points = pointsByMetric.get(key) ?? [];
      points.push({
        label: `${r.target}/${r.variant}/${r.repeat}`,
        count: value,
        ms: time,
      });
      pointsByMetric.set(key, points);
    }
  }
  results.correlations = [];
  for (const [metric, points] of pointsByMetric) {
    const r = pearson(points.map((p) => [p.count, p.ms])),
      proven = points.length >= 4 && r != null && r >= 0.8;
    results.correlations.push({ metric, points, r, proven });
    lines.push(
      `- **${cell(metric)}**: r=${fmt(r)}, ${proven ? "correlated in this run" : "not proven"}; ${points.map((p) => `${p.label} (${fmt(p.count)}, ${fmt(p.ms)})`).join("; ")}`,
    );
  }
  if (!pointsByMetric.size)
    lines.push(
      "Not proven: no paired count/timing points (counts-only runs cannot establish correlation).",
    );
  lines.push("", "## Errors and external requests", "");
  for (const r of records)
    if (r.info?.unexpectedRequests?.length || r.info?.pageErrors?.length)
      lines.push(
        `- ${r.target}/${r.scenario}/${r.variant}: ${cell(JSON.stringify({ unexpectedRequests: r.info.unexpectedRequests, pageErrors: r.info.pageErrors }))}`,
      );
  if (results.error) lines.push(`FAIL: ${cell(results.error)}`);
  return lines.join("\n") + "\n";
}
