export default `setcps(140 / 60 / 4)

drums: stack(
  sound("bd ~ sd ~"),
  sound("[mt,ht] ~ [mt,ht] ~"),

  sound("bd ~ rim ~").bank("oberheimdmx"),
  sound("hh*4"),

  // Jungle pattern
  sound("<bd ~ ~ bd>*8")
    .bank("sakatadpm48")
    .room(0.9)
    .roomdim(8000)
    .lpf(200)
    .pan(sine.slow(2)),
)
`;
