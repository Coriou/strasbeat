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
// Whether a count has been shown to move with time: in every build
// measured at four or more points, r clears 0.8 and the 5 % significance
// level for that many points. A high r over few points proves little —
// four points reach 0.8 by chance one time in five.
const CRITICAL = { 4: 0.95, 5: 0.878, 6: 0.811 };
export const bar = (n) => (n < 4 ? Infinity : (CRITICAL[n] ?? 0.8));
export function proven(byTarget) {
  const judged = Object.values(byTarget).filter((t) => t.n >= 4);
  return (
    judged.length > 0 && judged.every((t) => t.r != null && t.r >= bar(t.n))
  );
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
