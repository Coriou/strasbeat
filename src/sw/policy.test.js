import test from "node:test";
import assert from "node:assert/strict";
import { classify, cacheable } from "./policy.js";
import { DEFAULT_MANIFESTS } from "../default-samples.js";
const origin = "https://strasbeat.test";
const precache = new Set(["/index.html", "/assets/entry-a.js", "/favicon.svg"]);
function kind(url, options = {}) {
  return classify(
    {
      url: new URL(url, origin).href,
      method: "GET",
      mode: "cors",
      headers: new Headers(),
      ...options,
    },
    origin,
    precache,
  );
}

test("root navigations ignore query and hash, other navigations pass through", () => {
  for (const url of ["/", "/?action=new", "/index.html?x=1#code=x"])
    assert.equal(kind(url, { mode: "navigate" }), "shell");
  for (const url of ["/assets/x.js", "/other", "https://other.test/"])
    assert.equal(kind(url, { mode: "navigate" }), null);
});
test("shell assets and old/opt-in chunks have distinct caches", () => {
  assert.equal(kind("/assets/entry-a.js"), "precache");
  assert.equal(kind("/favicon.svg"), "precache");
  assert.equal(kind("/assets/old.js"), "asset");
});
test("every boot manifest has the SWR policy", () => {
  assert.equal(DEFAULT_MANIFESTS.length, 8);
  for (const url of DEFAULT_MANIFESTS) assert.equal(kind(url), "manifest", url);
});
test("only default audio bases, including GM data and GitHub case variants", () => {
  for (const url of [
    "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/0.wav",
    "https://raw.githubusercontent.com/TidalCycles/uzu-drumkit/main/bd/0.wav",
    "https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/machines/a.wav",
    "https://strudel.b-cdn.net/piano/a.wav",
    "https://felixroos.github.io/webaudiofontdata/sound/a.js",
  ])
    assert.equal(kind(url), "audio", url);
});
test("unlisted traffic, own script, partial requests and mutations pass through", () => {
  for (const url of [
    "/sw.js",
    "/sw.js?v=2",
    "/api/save",
    "/shareimage.png",
    "/strudel-cc/not-json",
    "/strudel-cc/user.json",
    "https://raw.githubusercontent.com/someone/pack/main/strudel.json",
    "https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/user.json",
    "https://strudel.b-cdn.net/user.json",
    "https://shabda.ndre.gr/",
    "https://analytics.example/script.js",
    "wss://strasbeat.test/assets/x",
    "https://strudel.b-cdn.net.evil.test/a.wav",
  ])
    assert.equal(kind(url), null, url);
  assert.equal(kind("/assets/entry-a.js", { method: "POST" }), null);
  assert.equal(
    kind("/assets/entry-a.js", {
      headers: new Headers({ range: "bytes=0-10" }),
    }),
    null,
  );
});
test("a request that may only be answered from the HTTP cache is left alone", () => {
  assert.equal(kind("/assets/entry-a.js", { cache: "only-if-cached" }), null);
  assert.equal(
    kind("/assets/entry-a.js", {
      cache: "only-if-cached",
      mode: "same-origin",
    }),
    "precache",
  );
});
test("only successful complete non-opaque responses may be stored", () => {
  assert.equal(cacheable(new Response("yes")), true);
  for (const status of [206, 404, 500])
    assert.equal(cacheable(new Response("no", { status })), false);
  assert.equal(cacheable({ ok: true, status: 200, type: "opaque" }), false);
});
