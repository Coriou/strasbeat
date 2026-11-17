// Launches handed to the open app window through window.launchQueue.
//
// The installed app declares launch_handler "focus-existing" with
// handle_links "preferred": a strasbeat link or a home-screen shortcut opened
// while the app window is up focuses that window WITHOUT navigating it, and
// the URL only arrives through the launch queue. Boot, meanwhile, reads the
// share hash and the shortcut action of the launch that opened the page from
// the address bar, so that launch must not be handled a second time.
//
// The queue may hold that boot launch (or, after a reload, the launch that
// first opened the window) by the time a consumer is set; setConsumer hands
// queued launches over synchronously, so whatever arrives during the call is
// skipped. A browser that queues the boot launch only later is covered by
// skipping a first launch whose URL is the page's own address at boot.
//
// Install it as early as possible: a real launch queued before the consumer
// exists is indistinguishable from the boot one and is skipped with it.

/**
 * @param {{ setConsumer(fn: (params: { targetURL?: string }) => void): void } | undefined} launchQueue
 * @param {{ bootHref: string }} opts  the address the page was opened at
 * @returns {{ setHandler(fn: (url: URL) => void): void }}
 *   Launches that arrive before setHandler are held and delivered to it.
 */
export function listenForLaunches(launchQueue, { bootHref }) {
  const held = [];
  let handler = null;
  let seenAny = false;
  const bootKey = urlKey(bootHref);

  const deliver = (url) => {
    if (handler) handler(url);
    else held.push(url);
  };

  if (launchQueue && typeof launchQueue.setConsumer === "function") {
    let flushing = true;
    launchQueue.setConsumer((params) => {
      const target = params?.targetURL;
      if (!target) return;
      const first = !seenAny;
      seenAny = true;
      if (flushing) return;
      let url;
      try {
        url = new URL(target);
      } catch (err) {
        console.warn("[strasbeat] unreadable launch URL:", target, err);
        return;
      }
      if (first && urlKey(url.href) === bootKey) return;
      deliver(url);
    });
    flushing = false;
  }

  return {
    setHandler(fn) {
      handler = fn;
      for (const url of held.splice(0)) fn(url);
    },
  };
}

// The same address however it is spelled: an empty "#" or a default port
// does not make a different launch.
function urlKey(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return String(href);
  }
}
