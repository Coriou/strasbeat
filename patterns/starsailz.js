export default `setcpm(120 / 4)

drums: stack(
  s("~ [bd,sd] ~ [bd,sd]").bank("oberheimdmx"),
  s("bd ~ bd ~"),
  s("~ hh ~ hh").bank("akaimpc60").pan(sine.fast(8)),
  s("hh*8").bank("mpc1000").pan(sine.slow(4)),
)
`;
