import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  branchName,
  deploymentGuard,
  repository,
  runStates,
  main,
} from "./ci-run.mjs";
test("arguments and branch names", () => {
  assert.equal(
    branchName(parseArgs(["perf", "probe", "--base", "main"]), "abcdef"),
    "ci/perf-probe",
  );
  assert.equal(branchName(parseArgs(["smoke"]), "abcdef"), "ci/smoke-abcdef");
  assert.equal(branchName(parseArgs(["test"]), "abcdef"), "ci/abcdef");
  assert.throws(() => parseArgs(["perf", "../bad"]));
  assert.throws(() => parseArgs(["test", "--base", "main"]));
  assert.throws(() => parseArgs(["perf", "--timeout", "0"]));
  assert.equal(
    parseArgs(["perf", "--scenarios", "sweep,typing"]).scenarios,
    "sweep,typing",
  );
  assert.throws(() => parseArgs(["smoke", "--scenarios", "sweep"]));
  assert.throws(() => parseArgs(["perf", "--scenarios", "a b"]));
});
test("guard requires exact committed deployment disable", () => {
  assert.equal(
    deploymentGuard('{"git":{"deploymentEnabled":{"ci/**":false}}}'),
    true,
  );
  for (const s of [
    "{}",
    "{",
    '{"git":{"deploymentEnabled":{"ci/**":"false"}}}',
  ])
    assert.throws(() => deploymentGuard(s));
});
test("origin owner parsing", () => {
  assert.deepEqual(repository("git@github.com:Coriou/strasbeat.git"), {
    owner: "Coriou",
    repo: "strasbeat",
  });
  assert.deepEqual(repository("https://github.com/Coriou/strasbeat"), {
    owner: "Coriou",
    repo: "strasbeat",
  });
  assert.throws(() => repository("https://example.com/a/b"));
});
test("run states require every workflow and successful conclusion", () => {
  const r = { workflowName: "CI", status: "completed", conclusion: "success" };
  assert.equal(runStates([], ["CI"]).complete, false);
  assert.equal(runStates([r], ["CI", "Perf"]).complete, false);
  assert.equal(runStates([r], ["CI"]).success, true);
  assert.equal(
    runStates([{ ...r, conclusion: "failure" }], ["CI"]).success,
    false,
  );
});
test("unsafe committed tree refuses before any push", async () => {
  const calls = [];
  await assert.rejects(
    main(["test", "--ref", "old"], async (p, a) => {
      calls.push([p, a]);
      return { stdout: a[0] === "rev-parse" ? "abc" : "{}" };
    }),
    /committed vercel/,
  );
  assert.equal(
    calls.some(([, a]) => a.includes("push")),
    false,
  );
});
test("wrong account refuses before push", async () => {
  const calls = [];
  await assert.rejects(
    main(["test", "--ref", "HEAD"], async (p, a) => {
      calls.push([p, a]);
      const stdout =
        p === "gh"
          ? "someone-else"
          : a[0] === "rev-parse"
            ? "abc"
            : a[0] === "show"
              ? '{"git":{"deploymentEnabled":{"ci/**":false}}}'
              : "git@github.com:Coriou/strasbeat.git";
      return { stdout };
    }),
    /not origin owner/,
  );
  assert.equal(
    calls.some(([, a]) => a.includes("push")),
    false,
  );
});

test("failure after push still checks deployments and deletes the branch", async () => {
  const calls = [];
  await assert.rejects(
    main(["test", "--ref", "HEAD"], async (program, args) => {
      calls.push([program, args]);
      if (program === "gh" && args[0] === "run")
        throw new Error("network failed");
      const stdout =
        program === "git"
          ? args[0] === "rev-parse"
            ? "abc123"
            : args[0] === "show"
              ? '{"git":{"deploymentEnabled":{"ci/**":false}}}'
              : args[0] === "remote"
                ? "git@github.com:Coriou/strasbeat.git"
                : ""
          : args[1] === "user"
            ? "Coriou"
            : "[]";
      return { stdout, code: 0 };
    }),
    /network failed/,
  );
  assert.ok(
    calls.some(
      ([p, a]) =>
        p === "gh" && a.some((s) => s.includes("deployments?sha=abc123")),
    ),
  );
  assert.ok(calls.some(([p, a]) => p === "git" && a.includes("--delete")));
});
test("a deployment the commit already had is not blamed on the push", async () => {
  // main's commit has its production deployment; pushing it to a ci/ branch
  // must only fail if a new one appears.
  const respond = (after) => async (program, args) => {
    const joined = args.join(" ");
    let stdout = "";
    if (program === "git") {
      if (args[0] === "rev-parse") stdout = "abc123";
      else if (args[0] === "show")
        stdout = '{"git":{"deploymentEnabled":{"ci/**":false}}}';
      else if (args[0] === "remote")
        stdout = "git@github.com:Coriou/strasbeat.git";
    } else if (args[1] === "user") stdout = "Coriou";
    else if (joined.includes("deployments?sha=")) {
      stdout = JSON.stringify(respond.pushed ? after : [{ id: 1 }]);
    } else if (args[0] === "run" && args[1] === "list")
      stdout = JSON.stringify([
        {
          databaseId: 7,
          workflowName: "CI",
          status: "completed",
          conclusion: "success",
          url: "u",
        },
      ]);
    if (program === "git" && args.includes("push")) respond.pushed = true;
    return { stdout, stderr: "", code: 0 };
  };
  const timers = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => timers(fn, 0);
  try {
    respond.pushed = false;
    assert.equal(
      await main(["test", "--ref", "HEAD"], respond([{ id: 1 }])),
      0,
    );
    respond.pushed = false;
    await assert.rejects(
      main(["test", "--ref", "HEAD"], respond([{ id: 1 }, { id: 2 }])),
      /created 1 deployment/,
    );
  } finally {
    globalThis.setTimeout = timers;
  }
});
test("tracked changes require an explicit ref", async () => {
  await assert.rejects(
    main(["test"], async (_p, a) => ({
      stdout:
        a[0] === "rev-parse"
          ? "abc"
          : a[0] === "show"
            ? '{"git":{"deploymentEnabled":{"ci/**":false}}}'
            : " M file.js",
    })),
    /Tracked changes/,
  );
});

test("chosen journeys run as a dispatch that replaces the push run", async () => {
  const calls = [];
  let dispatched = false;
  const respond = async (program, args) => {
    calls.push([program, ...args].join(" "));
    let stdout = "";
    if (program === "git") {
      if (args[0] === "rev-parse") stdout = "abc123";
      else if (args[0] === "show")
        stdout = '{"git":{"deploymentEnabled":{"ci/**":false}}}';
      else if (args[0] === "remote")
        stdout = "git@github.com:Coriou/strasbeat.git";
    } else if (args[1] === "user") stdout = "Coriou";
    else if (args.join(" ").includes("deployments?sha=")) stdout = "[]";
    else if (args[0] === "workflow") dispatched = true;
    else if (args[0] === "run" && args[1] === "list") {
      const run = (databaseId, workflowName, event, done) => ({
        databaseId,
        workflowName,
        event,
        status: done ? "completed" : "in_progress",
        conclusion: done ? "success" : "",
        url: "u",
      });
      stdout = JSON.stringify([
        run(7, "CI", "push", true),
        // Cancelled once the dispatch replaces it, and left out of the verdict.
        { ...run(8, "Perf", "push", dispatched), conclusion: "cancelled" },
        ...(dispatched ? [run(9, "Perf", "workflow_dispatch", true)] : []),
      ]);
    }
    return { stdout, stderr: "", code: 0 };
  };
  const timers = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => timers(fn, 0);
  try {
    assert.equal(
      await main(
        ["perf", "evidence", "--ref", "HEAD", "--scenarios", "sweep"],
        respond,
      ),
      0,
    );
  } finally {
    globalThis.setTimeout = timers;
  }
  assert.ok(calls.includes("gh run cancel 8"));
  assert.ok(
    calls.includes(
      "gh workflow run perf.yml --ref ci/perf-evidence -f base=main -f scenarios=sweep",
    ),
  );
});
