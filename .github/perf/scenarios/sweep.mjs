// Evidence, not a journey, and run on demand (`-f scenarios=sweep`): every
// view that has a calls-per-frame ceiling, at four pattern sizes. See
// playing.mjs for why the sizes of one view are the evidence, and
// docs/architecture.md ("Performance rig and ratchets") for the bar a
// count has to clear.
export { run } from "./playing.mjs";
export const name = "sweep";
export const description =
  "The playing journey's four 120 Hz views, each at four pattern sizes (1, 2, 4, 8 synth layers; 1, 2, 3, 6 drum lines for the beat grid).";
export const variants = [
  "roll@1",
  "roll@2",
  "roll",
  "roll@8",
  "collapsed@1",
  "collapsed@2",
  "collapsed",
  "collapsed@8",
  "scope@1",
  "scope@2",
  "scope",
  "scope@8",
  "beats@1",
  "beats@2",
  "beats",
  "beats@6",
];
