// Temporary upstream Drawer adapter for ?sb-frameloop=off. Delete this
// module together with the flag after the hardware comparison.
export function installLegacyDrawer(editor, bottomCanvas, drawTime) {
  // The Drawer's window. It keeps — and re-filters on every frame — each hap
  // inside `drawTime`, so the window is the roll's full four cycles only while
  // something shows them: the roll itself, or draw functions the pattern
  // registered. Otherwise it shrinks to the present moment, which is all that
  // highlighting and the shader uniforms read, and what upstream uses for any
  // pattern without painters. (Upstream picks the window after every evaluate
  // through setDrawTime; that call is intercepted here.)
  const NOW_ONLY = [0, 0];
  const _setDrawTime = editor.drawer.setDrawTime.bind(editor.drawer);
  const _invalidate = editor.drawer.invalidate.bind(editor.drawer);
  let paintersWantWindow = false;
  // Returns whether the window changed.
  function applyDrawWindow(wide) {
    const current = editor.drawer.drawTime;
    const wasWide = current[0] !== 0 || current[1] !== 0;
    if (wasWide === wide) return false;
    _setDrawTime(wide ? drawTime : NOW_ONLY);
    // The Drawer queries from its previous frame's right edge to the new one.
    // After shrinking, that edge lies in the future; make the next frame
    // re-anchor instead of querying backwards. After widening it lies behind
    // the stretch the invalidate that follows is about to queue; move it to
    // where a Drawer that had been wide all along would have it, or the next
    // frame queues the end of that stretch a second time.
    if (!wide) {
      editor.drawer.lastFrame = null;
    } else if (editor.drawer.lastFrame != null) {
      const sched = editor.repl?.scheduler;
      if (sched?.started) editor.drawer.lastFrame = sched.now() + drawTime[1];
    }
    return true;
  }
  editor.drawer.setDrawTime = (dt) => {
    // Upstream passes [0, 0] unless the evaluated pattern has painters.
    paintersWantWindow = Array.isArray(dt) && (dt[0] !== 0 || dt[1] !== 0);
    applyDrawWindow(paintersWantWindow || bottomCanvas.wantsHapWindow());
  };
  // Every evaluate (and the boot-time first frame) ends in an invalidate: the
  // one moment the pattern's painters and the code its haps point into are
  // both known. `refill` is for the invalidates below, which only query the
  // pattern on show again.
  function invalidateDrawer(scheduler, t, refill) {
    _invalidate(scheduler, t);
    bottomCanvas.afterInvalidate({
      code: editor.repl.state.activeCode,
      painters: editor.drawer.painters,
      haps: editor.drawer.visibleHaps,
      time: t ?? editor.drawer.scheduler?.now?.() ?? 0,
      refill,
    });
  }
  editor.drawer.invalidate = (scheduler, t) =>
    invalidateDrawer(scheduler, t, false);
  // The roll came into view or went out of it (pane collapse, mode switch).
  bottomCanvas.setOnHapDemandChange((wide) => {
    if (!applyDrawWindow(wide || paintersWantWindow)) return;
    const sched = editor.repl?.scheduler;
    if (!sched?.pattern) return;
    if (!wide) {
      // Drop the haps queued beyond the narrower window.
      if (sched.started) invalidateDrawer(sched, undefined, true);
      return;
    }
    // Stopped with nothing on the roll (the tab was switched): leave it empty.
    if (!sched.started && !bottomCanvas.hasFrame()) return;
    // Refill the window around the playhead (or, while stopped, around the
    // frame the roll last showed) so the roll does not come back half empty.
    const t = sched.started ? sched.now() : bottomCanvas.getLastTime();
    try {
      editor.drawer.visibleHaps =
        t > 0
          ? sched.pattern
              .queryArc(Math.max(0, t + drawTime[0]), t)
              .filter((hap) => hap.hasOnset())
          : [];
      invalidateDrawer(sched, t, true);
      bottomCanvas.draw(editor.drawer.visibleHaps, t);
    } catch (err) {
      console.warn("[strasbeat] could not refill the piano roll:", err);
    }
  });
}
