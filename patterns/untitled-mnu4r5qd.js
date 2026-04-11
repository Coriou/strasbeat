export default `setcpm(120 / 4)

drums: stack(
  s("bd*2").bank("casiorz1").gain(0.9),
  s("~ sd ~ sd").bank("casiorz1"),
  s("~ ~ ~ oh").bank("RolandTR909").gain(0.3),
  s("hh*8").bank("doepferms404").gain(0.45).pan(sine.fast(4))
)
`;
