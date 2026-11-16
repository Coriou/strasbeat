// Run a commit on GitHub's runners and bring the verdict back:
//
//   node scripts/ci-run.mjs test  [name]   tests + build            (ci/<name>)
//   node scripts/ci-run.mjs smoke [name]   … + the browser smoke    (ci/smoke-<name>)
//   node scripts/ci-run.mjs perf  [name]   … + the performance rig  (ci/perf-<name>)
//     [--ref <commit>] [--base <ref>] [--scenarios a,b] [--keep]
//     [--timeout <minutes>]
//
// It pushes the commit to a throwaway branch, waits for every workflow run
// of it, prints the results, and deletes the branch whatever happened.
//
// It exists because the hand-typed version of this went wrong once. Vercel
// reads vercel.json from the commit that is pushed, so a commit based on a
// tree older than the `git.deploymentEnabled: { "ci/**": false }` block
// became a public preview deployment. This refuses to push such a commit,
// refuses to push as the wrong GitHub account (two are logged in on the
// maintainer's machine), and afterwards checks that no deployment appeared.
// To measure an old commit, give it to the perf workflow as --base; it is
// checked out on the runner and never becomes a branch.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const SUMMARY_LINES = 120;

export function parseArgs(args) {
  const options = { mode: args[0], timeout: 45, keep: false };
  if (!["test", "smoke", "perf"].includes(options.mode))
    throw new Error(
      "Usage: ci-run.mjs test|smoke|perf [name] [--ref commit] [--keep] [--timeout minutes] [--base ref] [--scenarios a,b]",
    );
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--keep") options.keep = true;
    else if (["--ref", "--timeout", "--base", "--scenarios"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else if (!arg.startsWith("-") && !options.name) options.name = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  options.timeout = Number(options.timeout);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0)
    throw new Error("Timeout must be positive");
  if (options.base !== undefined && options.mode !== "perf")
    throw new Error("--base is only supported for perf");
  if (options.scenarios !== undefined) {
    if (options.mode !== "perf")
      throw new Error("--scenarios is only supported for perf");
    if (!/^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$/.test(options.scenarios))
      throw new Error("--scenarios takes journey names separated by commas");
  }
  if (options.name && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(options.name))
    throw new Error("Name must use letters, digits, hyphens or underscores");
  return options;
}
export const branchName = (o, sha) =>
  `ci/${o.mode === "test" ? "" : o.mode + "-"}${o.name ?? sha.slice(0, 12)}`;
export function deploymentGuard(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Committed vercel.json is not valid JSON");
  }
  if (value?.git?.deploymentEnabled?.["ci/**"] !== false)
    throw new Error(
      'Refusing push: committed vercel.json must set git.deploymentEnabled["ci/**"] === false',
    );
  return true;
}
export function repository(remote) {
  const match = remote.match(
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (!match) throw new Error("Origin must be a GitHub repository");
  return { owner: match[1], repo: match[2] };
}
export function runStates(runs, expected) {
  const seen = new Set(runs.map((r) => r.workflowName));
  const missing = expected.filter((n) => !seen.has(n));
  const complete =
    !missing.length &&
    runs.length > 0 &&
    runs.every((r) => r.status === "completed");
  return {
    complete,
    success: complete && runs.every((r) => r.conclusion === "success"),
    missing,
    states: runs.map(
      (r) =>
        `${r.databaseId} ${r.workflowName}: ${r.status}${r.conclusion ? "/" + r.conclusion : ""}`,
    ),
  };
}
// The only process boundary. Tests can replace it without invoking git or gh.
export function command(program, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (s) => {
      stdout += s;
    });
    child.stderr.on("data", (s) => {
      stderr += s;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // `code` is null when a signal killed the child: not a success either.
      if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `${program} ${args[0]} failed (${code ?? signal}): ${stderr}`,
          ),
        );
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}
export async function main(args, exec = command) {
  const o = parseArgs(args),
    git = async (...a) => (await exec("git", a)).stdout,
    gh = async (...a) => (await exec("gh", a)).stdout;
  const sha = await git("rev-parse", "--verify", `${o.ref ?? "HEAD"}^{commit}`);
  deploymentGuard(await git("show", `${sha}:vercel.json`));
  if (!o.ref && (await git("status", "--porcelain", "--untracked-files=no")))
    throw new Error(
      "Tracked changes are uncommitted; commit first or give --ref explicitly",
    );
  const { owner, repo } = repository(await git("remote", "get-url", "origin"));
  const login = await gh("api", "user", "--jq", ".login");
  if (login.toLowerCase() !== owner.toLowerCase())
    throw new Error(
      `Refusing push: active gh account ${login} is not origin owner ${owner}`,
    );
  // The commit may already have deployments of its own (main's does: its
  // production one). Only one that appears after this push is a failure.
  const deploymentIds = async () =>
    JSON.parse(
      await gh(
        "api",
        `repos/${owner}/${repo}/deployments?sha=${sha}&per_page=100`,
      ),
    ).map((d) => d.id);
  const deploymentsBefore = new Set(await deploymentIds());
  const branch = branchName(o, sha),
    remoteRef = `refs/heads/${branch}`;
  if (await git("ls-remote", "--heads", "origin", remoteRef))
    throw new Error(
      `Remote branch already exists: ${branch}; choose another name`,
    );
  // GitHub keeps a deleted branch's runs. An earlier invocation for this
  // commit under the same branch name left some; they are not this one's.
  const listRuns = async () =>
    JSON.parse(
      await gh(
        "run",
        "list",
        "--branch",
        branch,
        "--commit",
        sha,
        "--json",
        "databaseId,workflowName,event,status,conclusion,url",
        "--limit",
        "100",
      ),
    );
  const earlier = new Set((await listRuns()).map((r) => r.databaseId));
  const ourRuns = async () =>
    (await listRuns()).filter((r) => !earlier.has(r.databaseId));
  const push = (...a) =>
    exec("git", [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "origin",
      ...a,
    ]);
  let pushed = false,
    interrupted = false,
    cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      if (pushed && !o.keep) {
        await push("--delete", remoteRef);
        console.log(`Deleted ${branch}`);
      }
    })());
  const signal = () => {
    interrupted = true;
    console.error(
      "Interrupted; cleaning up the remote branch after the current command",
    );
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  let ok = false,
    error;
  try {
    // Mark before pushing: a connection can fail after the server accepted it.
    pushed = true;
    await push(`${sha}:${remoteRef}`);
    // Another base, or some journeys only, are inputs of a dispatched run.
    const dispatched =
      o.mode === "perf" && (o.base !== undefined || o.scenarios !== undefined);
    if (dispatched) {
      // A push also starts Perf. Cancel that run before dispatching ours;
      // expected runs below include CI and the dispatched Perf run.
      const until = Date.now() + 120000;
      let pushPerf;
      while (!pushPerf && Date.now() < until && !interrupted) {
        const runs = await ourRuns();
        pushPerf = runs.find(
          (r) => r.workflowName === "Perf" && r.event === "push",
        );
        if (!pushPerf) await new Promise((r) => setTimeout(r, 20000));
      }
      if (!pushPerf)
        throw new Error(
          "Push Perf run did not appear; the dispatch was not started",
        );
      if (pushPerf.status !== "completed")
        await gh("run", "cancel", String(pushPerf.databaseId));
      await gh(
        "workflow",
        "run",
        "perf.yml",
        "--ref",
        branch,
        "-f",
        `base=${o.base ?? "main"}`,
        ...(o.scenarios ? ["-f", `scenarios=${o.scenarios}`] : []),
      );
    }
    const expected = [
      "CI",
      ...(o.mode === "test" ? [] : [o.mode === "perf" ? "Perf" : "Smoke"]),
    ];
    const deadline = Date.now() + o.timeout * 60000,
      states = new Set();
    let finished = [],
      settled = 0;
    while (Date.now() < deadline && !interrupted) {
      const all = await ourRuns();
      // Only the explicitly superseded push Perf run is excluded; all other
      // runs for this SHA and branch must finish successfully.
      const runs = all.filter(
        (r) => !(dispatched && r.workflowName === "Perf" && r.event === "push"),
      );
      const summary = runStates(runs, expected);
      for (const s of summary.states)
        if (!states.has(s)) {
          console.log(s);
          states.add(s);
        }
      settled = summary.complete ? settled + 1 : 0;
      if (settled >= 2) {
        finished = runs;
        ok = summary.success;
        break;
      }
      await new Promise((r) => setTimeout(r, 20000));
    }
    if (!finished.length)
      throw new Error(
        interrupted
          ? "Run interrupted"
          : `Timed out after ${o.timeout} minutes`,
      );
    const artifactDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "strasbeat-ci-"),
    );
    console.log(`Artifacts: ${artifactDir}`);
    for (const run of finished) {
      console.log(`${run.workflowName}: ${run.conclusion} ${run.url}`);
      if (run.conclusion !== "success") {
        const logs = await exec(
          "gh",
          ["run", "view", String(run.databaseId), "--log-failed"],
          { allowFailure: true },
        );
        console.log(logs.stdout.split("\n").slice(-100).join("\n"));
      }
      const dest = path.join(artifactDir, String(run.databaseId));
      const download = await exec(
        "gh",
        ["run", "download", String(run.databaseId), "--dir", dest],
        { allowFailure: true },
      );
      // A run without artifacts (plain CI) is not worth a line.
      if (download.code && !/no valid artifacts/i.test(download.stderr))
        console.log(`Artifacts ${run.databaseId}: ${download.stderr}`);
    }
    async function summaries(dir) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await summaries(p);
        else if (e.name === "summary.md") {
          // The perf summary runs to hundreds of lines; the head is the
          // overview, the file has the rest.
          const lines = (await fs.readFile(p, "utf8")).split("\n");
          console.log(p);
          console.log(lines.slice(0, SUMMARY_LINES).join("\n"));
          if (lines.length > SUMMARY_LINES)
            console.log(`… ${lines.length - SUMMARY_LINES} more lines in ${p}`);
        }
      }
    }
    await summaries(artifactDir);
  } catch (e) {
    error = e;
  } finally {
    try {
      if (pushed) {
        const created = (await deploymentIds()).filter(
          (id) => !deploymentsBefore.has(id),
        );
        if (created.length) {
          ok = false;
          error = new Error(
            `DEPLOYMENT GUARD FAILURE: pushing ${branch} created ${created.length} deployment(s) for ${sha}: ${created.join(", ")}`,
          );
        }
      }
    } catch (e) {
      ok = false;
      error = e;
    }
    try {
      await cleanup();
    } finally {
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
    }
  }
  if (error) throw error;
  return ok ? 0 : 1;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`FAIL ${e.message}`);
      process.exitCode = 1;
    });
