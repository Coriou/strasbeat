// Ratchet logic: a checked-in ceiling per count, which a run may come in
// under (and then lower) but never over. Pure; tested in ratchets.test.js.
import { median } from "./stats.mjs";
export const tolerances = { exact: 0, calls: 0.02, heap: 0.05, timers: 0.05 };
// What `lower --init` creates when no list is given: the launch payload.
// (Total JS and the file count are reported but not ratcheted: a new lazy
// chunk is not a regression.)
export const initialMetrics = [
  "bundle.default.initialJsRaw",
  "bundle.default.initialJsGzip",
  "bundle.default.initialCssRaw",
  "bundle.default.initialCssGzip",
];
export function flatten(obj, prefix = "") {
  return Object.fromEntries(
    Object.entries(obj ?? {}).flatMap(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === "object" && !Array.isArray(v)
        ? Object.entries(flatten(v, key))
        : [[key, v]];
    }),
  );
}
export function measurements(results, target = "head") {
  const buckets = new Map();
  for (const r of results.records ?? []) {
    if (r.target !== target || r.pass === "timing" || r.pass === "diagnostic")
      continue;
    for (const [metric, value] of Object.entries(flatten(r.counts))) {
      const key = `${r.scenario}.${r.variant}.${metric}`;
      const b = buckets.get(key) ?? { values: [], valid: true };
      b.valid &&= r.status === "ok" && r.pacingValid !== false;
      if (Number.isFinite(value)) b.values.push(value);
      buckets.set(key, b);
    }
  }
  for (const [key, bucket] of buckets) {
    for (const r of results.records ?? []) {
      if (
        r.target !== target ||
        r.pass !== "count" ||
        !key.startsWith(`${r.scenario}.${r.variant}.`)
      )
        continue;
      const metric = key.slice(`${r.scenario}.${r.variant}.`.length);
      if (r.status !== "ok" || !Number.isFinite(flatten(r.counts)[metric]))
        bucket.valid = false;
    }
  }
  return Object.fromEntries(
    [...buckets].map(([k, b]) => [
      k,
      { value: median(b.values), valid: b.valid },
    ]),
  );
}
export function validate(ratchets) {
  if (!Array.isArray(ratchets.raises))
    throw new Error("ratchets.raises must be an array");
  for (const [k, r] of Object.entries(ratchets)) {
    if (k === "raises") continue;
    if (
      !Number.isFinite(r.max) ||
      r.max < 0 ||
      !Number.isFinite(r.tolerance) ||
      r.tolerance < 0 ||
      typeof r.unit !== "string"
    )
      throw new Error(`Invalid ratchet: ${k}`);
  }
}
// `journeys`: the journeys a run was asked for, when it was asked for some
// only (`--scenarios`). Ceilings of the others are not its business; the
// bundle is measured by every run. A full run answers for every ceiling.
export function check(ratchets, measured, prefix = "", journeys = null) {
  validate(ratchets);
  const asked = (k) =>
    !journeys || ["bundle", ...journeys].includes(k.split(".")[0]);
  return Object.entries(ratchets)
    .filter(([k]) => k !== "raises" && k.startsWith(prefix) && asked(k))
    .map(([key, r]) => {
      const m = measured[key];
      const reason =
        !m || !Number.isFinite(m.value)
          ? "missing"
          : !m.valid
            ? "invalid window"
            : m.value > r.max * (1 + r.tolerance)
              ? "over ceiling"
              : "";
      return {
        key,
        max: r.max,
        value: m?.value ?? null,
        ok: !reason,
        reason,
        canLower: !reason && m.value < r.max * (1 - r.tolerance),
      };
    });
}
export function lower(ratchets, measured, init = []) {
  validate(ratchets);
  const next = structuredClone(ratchets);
  for (const key of init) {
    if (next[key]) continue;
    const m = measured[key];
    if (!m?.valid || !Number.isFinite(m.value))
      throw new Error(`Cannot initialize ${key}: missing or invalid`);
    const kind = /calls|Calls/.test(key)
      ? "calls"
      : /heap|Heap/.test(key)
        ? "heap"
        : /timers/.test(key)
          ? "timers"
          : "exact";
    next[key] = {
      max: ceiling(m.value),
      tolerance: tolerances[kind],
      unit: /[Bb]ytes|Raw|Gzip|heap/.test(key) ? "bytes" : "count",
    };
  }
  for (const key of Object.keys(next)) {
    const m = measured[key];
    if (key !== "raises" && m?.valid && Number.isFinite(m.value))
      next[key].max = Math.min(next[key].max, ceiling(m.value));
  }
  // Metrics in order, the exceptions list last: a stable file to diff.
  const { raises, ...metrics } = next;
  return {
    ...Object.fromEntries(
      Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b)),
    ),
    raises,
  };
}

// A ceiling is written to two decimals, rounded up so the run it came from
// passes it.
function ceiling(value) {
  return Math.ceil(value * 100 - 1e-9) / 100;
}
export function guard(base, head) {
  validate(base);
  validate(head);
  const allowed = new Set(
    head.raises
      .filter((r) => typeof r.reason === "string" && r.reason.trim())
      .map((r) => r.key),
  );
  return Object.entries(base)
    .filter(([k]) => k !== "raises")
    .flatMap(([key, b]) => {
      const h = head[key];
      // Increasing tolerance is another way of raising the effective ceiling.
      return (!h ||
        h.max > b.max ||
        h.tolerance > b.tolerance ||
        h.unit !== b.unit) &&
        !allowed.has(key)
        ? [`${key}: raised, removed, or definition changed without a reason`]
        : [];
    });
}
