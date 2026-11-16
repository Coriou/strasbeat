// Small statistics for the rig. Pure; tested in stats.test.js.
export function quantile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p,
    lo = Math.floor(i);
  return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo);
}
export const median = (a) => quantile(a, 0.5);
export function stats(a) {
  if (!a.length)
    return { n: 0, median: null, min: null, max: null, spread: null };
  const m = median(a),
    min = Math.min(...a),
    max = Math.max(...a);
  return {
    n: a.length,
    median: m,
    min,
    max,
    p95: quantile(a, 0.95),
    spread: m === 0 ? (max === min ? 0 : null) : (max - min) / Math.abs(m),
  };
}
export function pearson(points) {
  if (points.length < 2) return null;
  const n = points.length,
    x = points.reduce((s, p) => s + p[0], 0) / n,
    y = points.reduce((s, p) => s + p[1], 0) / n;
  let xy = 0,
    xx = 0,
    yy = 0;
  for (const [a, b] of points) {
    xy += (a - x) * (b - y);
    xx += (a - x) ** 2;
    yy += (b - y) ** 2;
  }
  return xx && yy ? xy / Math.sqrt(xx * yy) : null;
}
export function paired(base, head) {
  const differences = head.slice(0, base.length).map((v, i) => v - base[i]);
  return {
    base: stats(base),
    head: stats(head),
    differences: stats(differences),
  };
}
export function slope(points) {
  const n = points.length,
    sx = points.reduce((s, p) => s + p[0], 0),
    sy = points.reduce((s, p) => s + p[1], 0);
  const den = n * points.reduce((s, p) => s + p[0] ** 2, 0) - sx ** 2;
  return den
    ? (n * points.reduce((s, p) => s + p[0] * p[1], 0) - sx * sy) / den
    : 0;
}
