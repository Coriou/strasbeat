// One measured window: reset the in-page counters, run an action, and read
// back counts (V8 call counts by module, DOM and canvas activity, CDP
// layout and style counts) or timings, plus a CPU profile or a trace on
// request. Counts and timings come from separate passes because the
// instrumentation that counts also slows the page down.
import fs from "node:fs/promises";
import path from "node:path";
import { census, profileTable } from "./symbols.mjs";
import { stats } from "./stats.mjs";
export async function metrics(cdp) {
  return Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
}
export const delta = (a, b) =>
  Object.fromEntries(
    Object.entries(b)
      .filter(([k]) => /Duration$|Count$|^Nodes$|^JSEventListeners$/.test(k))
      .map(([k, v]) => [k, v - (a[k] ?? 0)]),
  );
export async function heap(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const h = await cdp.send("Runtime.getHeapUsage"),
    m = await metrics(cdp);
  return {
    heapBytes: h.usedSize,
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
  };
}
export async function windowMeasure(
  ctx,
  action,
  { clock = true, diagnostics = true } = {},
) {
  const { page, cdp, counting, symbols } = ctx;
  await page.evaluate((clock) => {
    window.__perf.reset();
    if (clock) window.__perf.startClock();
  }, clock);
  if (counting) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: false,
    });
    await cdp.send("Profiler.takePreciseCoverage");
  }
  const profile = diagnostics && ctx.profile,
    trace = diagnostics && ctx.trace;
  const stem = `${ctx.target}-${ctx.scenario}-${ctx.variant}-${ctx.repeat}-${ctx.pass}-${ctx.serial++}`;
  if (profile) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  if (trace)
    await ctx.browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        "v8",
        "blink.user_timing",
        "disabled-by-default-devtools.timeline",
      ],
    });
  const before = await metrics(cdp);
  let result, coverage, prof, traceData;
  try {
    result = await action();
  } finally {
    if (counting) {
      coverage = (await cdp.send("Profiler.takePreciseCoverage")).result;
      await cdp.send("Profiler.stopPreciseCoverage");
    }
    if (profile) prof = (await cdp.send("Profiler.stop")).profile;
    if (trace) traceData = await ctx.browser.stopTracing();
  }
  const after = await metrics(cdp);
  // A task hop drains the final frame's MessageChannel callback.
  const observed = await page.evaluate(
    () =>
      new Promise((resolve) =>
        setTimeout(() => {
          const v = window.__perf.snapshot();
          window.__perf.active = false;
          window.__perf.stopClock();
          resolve(v);
        }, 0),
      ),
  );
  const change = delta(before, after),
    c = coverage ? census(coverage, symbols) : null;
  const info = { observed, performance: change, action: result, top: c?.top };
  if (prof) {
    await fs.mkdir(path.join(ctx.out, "profiles"), { recursive: true });
    await fs.writeFile(
      path.join(ctx.out, "profiles", stem + ".cpuprofile"),
      JSON.stringify(prof),
    );
    info.profile = profileTable(prof, symbols);
  }
  if (traceData) {
    await fs.mkdir(path.join(ctx.out, "traces"), { recursive: true });
    await fs.writeFile(path.join(ctx.out, "traces", stem + ".json"), traceData);
  }
  return {
    counts: counting
      ? {
          calls: c.calls,
          groups: c.groups,
          mutations: observed.mutations,
          transactions: observed.transactions,
          canvas: observed.canvas,
          raf: observed.raf,
          timers: observed.timers,
          layouts: change.LayoutCount,
          styleRecalcs: change.RecalcStyleCount,
        }
      : {},
    timings: {
      scriptMs: change.ScriptDuration * 1000,
      taskMs: change.TaskDuration * 1000,
      frameMs: stats(observed.frames.map((f) => f.ms)),
      framesOverBudget: observed.frames.filter((f) => f.ms > 1000 / 120).length,
      longTasks: observed.longTasks.length,
      longAnimationFrames: observed.loaf.length,
    },
    info,
  };
}
export function network(cdp) {
  const rows = new Map();
  let originTimestamp;
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.type === "Document" && originTimestamp == null)
      originTimestamp = e.timestamp;
    rows.set(e.requestId, {
      url: e.request.url,
      type: e.type,
      start: e.timestamp,
      decoded: 0,
      encoded: 0,
      chunks: [],
    });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = rows.get(e.requestId);
    if (r) {
      r.type = e.type;
      r.cached = !!(e.response.fromDiskCache || e.response.fromServiceWorker);
      r.status = e.response.status;
    }
  });
  cdp.on("Network.dataReceived", (e) => {
    const r = rows.get(e.requestId);
    if (r) {
      r.decoded += e.dataLength;
      r.encoded += e.encodedDataLength;
      r.chunks.push({
        at: e.timestamp,
        decoded: e.dataLength,
        encoded: e.encodedDataLength,
      });
    }
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = rows.get(e.requestId);
    if (r) {
      r.end = e.timestamp;
      r.encoded = e.encodedDataLength;
    }
  });
  return {
    rows,
    at(ms) {
      const byType = {};
      for (const r of rows.values()) {
        if ((r.start - originTimestamp) * 1000 > ms) continue;
        const b = (byType[r.type] ??= {
          requests: 0,
          decodedBytes: 0,
          encodedBytes: 0,
        });
        b.requests++;
        const chunks = r.chunks.filter(
          (c) => (c.at - originTimestamp) * 1000 <= ms,
        );
        b.decodedBytes += chunks.reduce((s, c) => s + c.decoded, 0);
        b.encodedBytes +=
          (r.end - originTimestamp) * 1000 <= ms
            ? r.encoded
            : chunks.reduce((s, c) => s + c.encoded, 0);
      }
      return byType;
    },
  };
}

// What the heap holds, by kind of object: `{ "type:name": { count, bytes } }`
// from a V8 heap snapshot. Two of these, taken a number of cycles apart, show
// what a slow leak is made of (see scenarios/memory.mjs, `--trace memory`).
export async function heapCensus(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const chunks = [];
  const onChunk = (event) => chunks.push(event.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  }
  const snapshot = JSON.parse(chunks.join(""));
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const size = fields.length;
  const typeAt = fields.indexOf("type");
  const nameAt = fields.indexOf("name");
  const bytesAt = fields.indexOf("self_size");
  const census = {};
  for (let i = 0; i < snapshot.nodes.length; i += size) {
    const type = types[snapshot.nodes[i + typeAt]];
    // Strings and numbers are keyed by type alone: their "name" is their
    // content, which would make every one of them its own kind.
    const name = [
      "string",
      "concatenated string",
      "sliced string",
      "number",
      "bigint",
    ].includes(type)
      ? ""
      : String(snapshot.strings[snapshot.nodes[i + nameAt]]).slice(0, 80);
    const key = `${type}:${name}`;
    const entry = (census[key] ??= { count: 0, bytes: 0 });
    entry.count++;
    entry.bytes += snapshot.nodes[i + bytesAt];
  }
  return census;
}

// The kinds that grew most between two censuses, by bytes.
export function censusGrowth(before, after, limit = 40) {
  const rows = [];
  for (const [kind, now] of Object.entries(after)) {
    const then = before[kind] ?? { count: 0, bytes: 0 };
    const bytes = now.bytes - then.bytes;
    const count = now.count - then.count;
    if (bytes > 0 || count > 0) rows.push({ kind, count, bytes });
  }
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}
