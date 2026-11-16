// Build side of the service worker: emits /sw.js as one self-contained
// classic script (a nested Vite build of worker.js, or of destroy.js when
// STRASBEAT_SW=off), with the precache list from build.js compiled in, and
// writes the build identifier into index.html.
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import { makePrecache, PUBLIC_SHELL, contentBuildId } from "./build.js";

// STRASBEAT_BUILD_ID replaces the identifier and is also compiled into the
// entry chunk, so two builds of the same source get different hashed files.
// That is what the service-worker lifecycle test needs ("a new deploy");
// leave it unset for real deploys.
export const buildTag = () => process.env.STRASBEAT_BUILD_ID ?? "";

export function buildIdPlugin() {
  return {
    name: "strasbeat:build-id",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const id = buildTag() || contentBuildId(Object.keys(ctx.bundle ?? {}));
        return [
          {
            tag: "meta",
            attrs: { name: "strasbeat-build", content: id },
            injectTo: "head",
          },
        ];
      },
    },
  };
}

export function serviceWorkerPlugin({ enabled }) {
  let config;
  return {
    name: "strasbeat:service-worker",
    apply: "build",
    enforce: "post",
    configResolved(value) {
      config = value;
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        let data = { precache: [], allAssets: [], version: "off" };
        if (enabled) {
          const publicFiles = Object.fromEntries(
            PUBLIC_SHELL.map((name) => [
              name,
              {
                type: "asset",
                source: fs.readFileSync(path.join(config.publicDir, name)),
              },
            ]),
          );
          data = makePrecache(bundle, publicFiles);
          // Guard the exclusion against upstream chunk-graph changes too.
          for (const pkg of ["csound", "xen"]) {
            const root = Object.values(bundle).find(
              (item) =>
                item.type === "chunk" &&
                item.facadeModuleId?.includes(`/@strudel/${pkg}/`),
            );
            if (!root)
              this.error(`Service worker: cannot find opt-in ${pkg} entry`);
            const seen = new Set();
            const visit = (name) => {
              if (seen.has(name) || bundle[name]?.isEntry) return;
              seen.add(name);
              [
                ...(bundle[name]?.imports ?? []),
                ...(bundle[name]?.dynamicImports ?? []),
              ].forEach(visit);
            };
            visit(root.fileName);
            if (!data.excluded.some((name) => seen.has(name)))
              this.error(
                `Service worker: expected a large excluded ${pkg} chunk; review the precache rule`,
              );
          }
          console.log(
            `[strasbeat:sw] precache ${data.precache.length} files, ${data.total} raw bytes; excluded ${data.excluded.join(", ")}`,
          );
        }
        const result = await build({
          configFile: false,
          publicDir: false,
          logLevel: "warn",
          define: {
            __PRECACHE__: JSON.stringify(data.precache),
            __ALL_ASSETS__: JSON.stringify(data.allAssets),
            __SW_VERSION__: JSON.stringify(data.version),
          },
          build: {
            write: false,
            target: "es2022",
            minify: true,
            lib: {
              entry: path.join(
                config.root,
                `src/sw/${enabled ? "worker" : "destroy"}.js`,
              ),
              formats: ["iife"],
              name: "StrasbeatWorker",
            },
          },
        });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap(
          (entry) => entry.output,
        );
        if (outputs.length !== 1 || outputs[0].type !== "chunk")
          this.error("Service worker must be one self-contained script");
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: outputs[0].code,
        });
      },
    },
  };
}
