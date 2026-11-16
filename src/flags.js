// Per-browser switches for things that are on by default and may need to
// be turned off on one machine: `?sb-<name>=off` in the URL turns <name> off
// and remembers it (localStorage "strasbeat:flag:<name>"), so an installed
// app with no address bar keeps the choice; `?sb-<name>=on` forgets it.
//
// Flags in use are listed in docs/architecture.md ("Flags"). Add one only
// for a change that could need switching off in the field, and remove it
// once the change has proven itself.
//
// Reading a flag never throws: the storage getter itself can throw in a
// private context, as can any read or write.
export function flagEnabled(
  name,
  {
    search = globalThis.location?.search ?? "",
    storage = () => globalThis.localStorage,
  } = {},
) {
  const key = `strasbeat:flag:${name}`;
  let value;
  try {
    value = new URLSearchParams(search).get(`sb-${name}`);
  } catch {
    /* Use the stored value. */
  }
  if (value === "off" || value === "on") {
    try {
      if (value === "off") storage()?.setItem(key, "off");
      else storage()?.removeItem(key);
    } catch {
      /* The URL still applies to this session. */
    }
    return value !== "off";
  }
  try {
    return storage()?.getItem(key) !== "off";
  } catch {
    return true;
  }
}
