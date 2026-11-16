// Registering a sound must not copy the whole sound map.
//
// superdough keeps its sounds in a nanostores `map` and registers each one
// with `soundMap.setKey(name, sound)`. nanostores answers every setKey by
// building a new object (`{ ...value, [name]: sound }`), so a map that
// already holds n sounds costs n property writes for the next one. Boot
// registers about 1,850 sounds one at a time: 1.7 million writes, measured at
// 125 ms out of 446 ms of boot CPU on a fast machine, all of it on the main
// thread while the editor is already on screen.
//
// installSoundMapBatching() swaps setKey for one that writes into the map's
// current object. `soundMap.get()` sees a new sound at once, exactly as
// before. What changes is the notification: listeners used to hear about
// every single sound, each time with a fresh object; now a burst of
// registrations ends in one fresh object and one notification, a microtask
// later. Nothing in strasbeat or in the Strudel packages it bundles listens
// to the map (they all read it at the moment of use), and upstream's own
// `aliasBank` already edits the object in place before publishing a copy.
//
// It leans on three things nanostores does today — the map exposes `value`,
// `set()` and the listener count `lc`. If an upgrade takes one away, nothing
// is patched, the old behaviour stays, and a warning says so
// (src/sound-map-batch.test.js checks the installed version).

/**
 * @param {object} soundMap  superdough's `soundMap`
 * @param {object} [opts]
 * @param {(fn: () => void) => void} [opts.schedule]  runs the notification
 *   after the current burst; a microtask by default
 * @returns {boolean} whether registration is batched from now on
 */
export function installSoundMapBatching(
  soundMap,
  { schedule = queueMicrotask } = {},
) {
  if (soundMap?.setKey?.strasbeatBatched) return true;
  const usable =
    soundMap != null &&
    typeof soundMap.setKey === "function" &&
    typeof soundMap.set === "function" &&
    typeof soundMap.lc === "number" &&
    soundMap.value != null &&
    typeof soundMap.value === "object";
  if (!usable) {
    console.warn(
      "[strasbeat] the sound map is not the store sound-map-batch.js expects — sounds still load, but registering them is slow again (see src/sound-map-batch.js).",
    );
    return false;
  }

  let publishQueued = false;
  const publish = () => {
    publishQueued = false;
    // A new object, so a listener comparing by identity sees the change:
    // one copy for the whole burst instead of one per sound.
    soundMap.set({ ...soundMap.value });
  };

  const setKey = (key, value) => {
    const sounds = soundMap.value;
    if (value === undefined) {
      if (!(key in sounds)) return;
      delete sounds[key];
    } else {
      if (sounds[key] === value) return;
      sounds[key] = value;
    }
    if (soundMap.lc > 0 && !publishQueued) {
      publishQueued = true;
      schedule(publish);
    }
  };
  setKey.strasbeatBatched = true;
  soundMap.setKey = setKey;
  return true;
}
