// Numeric playback window. Query boundaries belong to this object, never to
// a frame: consecutive slices meet exactly, and prefetched onsets stay private
// until they reach the visible window. Published arrays are immutable snapshots
// so the bottom canvas can keep its last frame after playback stops.
export class HapWindow {
  constructor(drawTime = [-2, 2]) {
    this.fullDrawTime = drawTime;
    this.drawTime = drawTime;
    this.rollDemand = true;
    this.painterDemand = false;
    this.records = [];
    this.visibleHaps = [];
    this.activeHaps = [];
    this.activeRecords = [];
    this.painters = [];
    this.horizon = null;
    this.time = null;
    this.needsRefill = false;
  }

  // One slice is 1/6 second at the current tempo. A tempo change takes
  // effect at the next query; the already queried boundary stays untouched.
  // A clock that stands still (`setcps(0)`) has no sixth of a second in
  // cycles; any small slice will do, since time is not advancing into it.
  slice(cps) {
    return cps > 0 && Number.isFinite(cps) ? cps / 6 : 1 / 12;
  }

  setDrawTime(dt) {
    this.painterDemand = dt[0] !== 0 || dt[1] !== 0;
    this.updateDemand();
  }

  updateDemand() {
    const next =
      this.rollDemand || this.painterDemand ? this.fullDrawTime : [0, 0];
    if (next[0] === this.drawTime[0] && next[1] === this.drawTime[1])
      return false;
    this.drawTime = next;
    this.needsRefill = true;
    return true;
  }

  setRollDemand(wide, pattern, time, cps, { playing, hasFrame }) {
    this.rollDemand = wide;
    if (!this.updateDemand()) return false;
    // A stopped tab swap deliberately cleared the canvas. A layout change
    // must not resurrect the previous document's notes.
    if (!pattern || (!playing && !hasFrame)) return false;
    this.refill(pattern, time, cps);
    return true;
  }

  query(pattern, begin, end, painters) {
    const haps = pattern.queryArc(
      begin,
      end,
      painters ? { painters } : undefined,
    );
    for (const hap of haps) {
      if (!hap.hasOnset()) continue;
      this.records.push({
        hap,
        begin: Number(hap.whole.begin),
        end: Number(hap.whole.end),
        endClipped: Number(hap.endClipped),
      });
    }
    this.horizon = end;
    return haps;
  }

  // A note that began before `begin` and is still sounding comes back from
  // a query only as a fragment without an onset. Its onset is fetched with a
  // point query at the moment it began, never by querying the whole stretch
  // back to it. `known` holds the onset times that need no query.
  recoverOnsets(pattern, haps, begin, known = new Set()) {
    const horizon = this.horizon;
    for (const hap of haps) {
      if (!hap.whole) continue;
      const onset = Number(hap.whole.begin);
      if (onset >= begin || known.has(onset)) continue;
      known.add(onset);
      this.query(pattern, onset, onset);
    }
    this.horizon = horizon;
  }

  refill(pattern, time, cps) {
    const begin = Math.max(0, time - Math.abs(this.drawTime[0]));
    const end = Math.max(0, time + this.drawTime[1]) + this.slice(cps);
    // Preserve tails whose clip extends beyond their whole span: a query at
    // the new left edge cannot discover those. Backward jumps start afresh.
    this.records =
      this.pattern === pattern && time >= this.time
        ? this.records.filter(
            (record) => record.begin < begin && record.endClipped >= begin,
          )
        : [];
    const recovered = new Set(this.records.map((record) => record.begin));
    this.painters = [];
    const haps = this.query(pattern, begin, end, this.painters);
    // Only on re-anchoring, never on a steady frame.
    this.recoverOnsets(pattern, haps, begin, recovered);
    this.pattern = pattern;
    this.needsRefill = false;
    this.publish(time);
  }

  // `time` may lie before the last frame: the scheduler's clock steps back
  // when an evaluate raises the tempo, and a restart begins near zero. Either
  // way what was played before `time` stays (after a restart nothing was),
  // as upstream keeps it; refilling here would redraw the past of the roll
  // with notes of the new pattern that never sounded.
  invalidate(pattern, time, cps) {
    const samePattern = this.pattern === pattern;
    this.pattern = pattern;
    this.records = this.records.filter((record) => record.begin < time);
    this.painters = [];
    const begin = Math.max(time, 0);
    const haps = this.query(
      pattern,
      begin,
      Math.max(0, time + this.drawTime[1]) + this.slice(cps),
      this.painters,
    );
    // A new pattern's notes that are already under way at `time` are shown
    // (and highlighted) from where they began, as upstream shows them. The
    // same pattern queried again still has those notes among its records.
    if (!samePattern) this.recoverOnsets(pattern, haps, begin);
    this.needsRefill = false;
    this.publish(time);
  }

  advance(pattern, time, cps) {
    const slice = this.slice(cps);
    // The scheduler's clock is recomputed on every tick and can come out a
    // hair earlier than the frame before when the audio clock has not moved.
    // That is not a jump: stand still rather than refill the whole window.
    if (this.time !== null && time < this.time && this.time - time < 1e-6) {
      time = this.time;
    }
    // A background-tab gap must not become a query spanning the whole gap.
    if (
      this.needsRefill ||
      this.horizon === null ||
      time < this.time ||
      time - this.time > Math.max(slice * 2, cps / 2)
    ) {
      this.refill(pattern, time, cps);
      return;
    }
    const right = time + this.drawTime[1];
    if (this.horizon <= right) {
      this.query(pattern, this.horizon, right + slice);
    }
    this.publish(time);
  }

  publish(time) {
    const left = time - Math.abs(this.drawTime[0]);
    const right = time + this.drawTime[1];
    let kept = 0;
    let visibleCount = 0;
    let activeCount = 0;
    let visible = this.visibleHaps;
    let active = this.activeHaps;
    let activeRecords = this.activeRecords;
    // Copy only at the first membership difference. Most frames touch just
    // numbers and retain the exact published array identities.
    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i];
      // A note is published for at least one frame once its onset is
      // reached, even if it ended before this frame came (a slow frame, a
      // short note and the narrow window): the shader's pulses count onsets.
      if (record.endClipped < left && (record.shown || record.begin > right))
        continue;
      this.records[kept++] = record;
      if (record.begin > right) continue;
      record.shown = true;
      if (visible[visibleCount] !== record.hap) {
        if (visible === this.visibleHaps)
          visible = visible.slice(0, visibleCount);
        visible[visibleCount] = record.hap;
      }
      visibleCount++;
      if (record.begin > time || record.endClipped < time) continue;
      if (active[activeCount] !== record.hap) {
        if (active === this.activeHaps) {
          active = active.slice(0, activeCount);
          activeRecords = activeRecords.slice(0, activeCount);
        }
        active[activeCount] = record.hap;
        activeRecords[activeCount] = record;
      }
      activeCount++;
    }
    this.records.length = kept;
    this.visibleHaps =
      visible.length === visibleCount
        ? visible
        : visible.slice(0, visibleCount);
    this.activeHaps =
      active.length === activeCount ? active : active.slice(0, activeCount);
    this.activeRecords =
      activeRecords.length === activeCount
        ? activeRecords
        : activeRecords.slice(0, activeCount);
    this.time = time;
  }
}
