export default `setcpm(120 / 4)

drums: stack(
  s("~ [bd,sd] ~ [bd,sd]").bank("oberheimdmx"),
  s("bd ~ bd ~"),
  s("~ hh ~ hh").bank("akaimpc60").pan(sine.fast(8)),
  s("hh*8").bank("mpc1000").pan(sine.slow(4)),
)

melody: progression('C Am Dm G')
  .slice([0, 0.25, 0.5, 0.75], "0 1 1 <2 3>")
  .s("gm_piano")
  .release(2)
  .room(0.9)
  .chorus(0.6)
  .gain(isaw.range(0, 0.6).fast(4))
`;
