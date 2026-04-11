// Shared GM instrument and drum mappings for inbound MIDI features.
// Every Strudel sound name here must be verified with strasbeat.hasSound()
// in the browser. See CLAUDE.md "Sound names are NOT 1:1 with General MIDI".
//
// Used by: src/midi-to-strudel.js (file import), and eventually live capture
// migration (src/midi-bridge.js).

// GM program 0–127 → Strudel soundfont name.
// Grouped by GM family (8 instruments per family). Names that don't exist in
// Strudel's soundMap fall back per the family fallback table below.
//
// Verified against strasbeat.hasSound() / strasbeat.findSounds() as of
// 2026-04-11. If a name stops resolving after a Strudel version bump, re-check
// with findSounds and update here.
export const GM_INSTRUMENT_MAP = {
  // Piano (0–7)
  0: "gm_piano",
  1: "gm_piano", // bright acoustic → same soundfont
  2: "gm_epiano1", // electric grand
  3: "gm_piano", // honky-tonk isn't exposed in the shipped soundMap
  4: "gm_epiano1", // EP1
  5: "gm_epiano2", // EP2
  6: "gm_harpsichord",
  7: "gm_clavinet",

  // Chromatic percussion (8–15)
  8: "gm_celesta",
  9: "gm_glockenspiel",
  10: "gm_music_box",
  11: "gm_vibraphone",
  12: "gm_marimba",
  13: "gm_xylophone",
  14: "gm_tubular_bells",
  15: "gm_dulcimer",

  // Organ (16–23)
  16: "gm_drawbar_organ",
  17: "gm_percussive_organ",
  18: "gm_rock_organ",
  19: "gm_church_organ",
  20: "gm_reed_organ",
  21: "gm_accordion",
  22: "gm_harmonica",
  23: "gm_accordion", // tango accordion isn't exposed in the shipped soundMap

  // Guitar (24–31)
  24: "gm_acoustic_guitar_nylon",
  25: "gm_acoustic_guitar_steel",
  26: "gm_electric_guitar_jazz",
  27: "gm_electric_guitar_clean",
  28: "gm_electric_guitar_muted",
  29: "gm_overdriven_guitar",
  30: "gm_distortion_guitar",
  31: "gm_guitar_harmonics",

  // Bass (32–39)
  32: "gm_acoustic_bass",
  33: "gm_electric_bass_finger",
  34: "gm_electric_bass_pick",
  35: "gm_fretless_bass",
  36: "gm_slap_bass_1",
  37: "gm_slap_bass_2",
  38: "gm_synth_bass_1",
  39: "gm_synth_bass_2",

  // Strings (40–47)
  40: "gm_violin",
  41: "gm_viola",
  42: "gm_cello",
  43: "gm_contrabass",
  44: "gm_tremolo_strings",
  45: "gm_pizzicato_strings",
  46: "gm_orchestral_harp",
  47: "gm_timpani",

  // Ensemble (48–55)
  48: "gm_string_ensemble_1",
  49: "gm_string_ensemble_2",
  50: "gm_synth_strings_1",
  51: "gm_synth_strings_2",
  52: "gm_choir_aahs",
  53: "gm_voice_oohs",
  54: "gm_synth_choir",
  55: "gm_orchestra_hit",

  // Brass (56–63)
  56: "gm_trumpet",
  57: "gm_trombone",
  58: "gm_tuba",
  59: "gm_muted_trumpet",
  60: "gm_french_horn",
  61: "gm_brass_section",
  62: "gm_synth_brass_1",
  63: "gm_synth_brass_2",

  // Reed (64–71)
  64: "gm_soprano_sax",
  65: "gm_alto_sax",
  66: "gm_tenor_sax",
  67: "gm_baritone_sax",
  68: "gm_oboe",
  69: "gm_english_horn",
  70: "gm_bassoon",
  71: "gm_clarinet",

  // Pipe (72–79)
  72: "gm_piccolo",
  73: "gm_flute",
  74: "gm_recorder",
  75: "gm_pan_flute",
  76: "gm_blown_bottle",
  77: "gm_shakuhachi",
  78: "gm_whistle",
  79: "gm_ocarina",

  // Synth lead (80–87)
  80: "gm_lead_1_square",
  81: "gm_lead_2_sawtooth",
  82: "gm_lead_3_calliope",
  83: "gm_lead_4_chiff",
  84: "gm_lead_5_charang",
  85: "gm_lead_6_voice",
  86: "gm_lead_7_fifths",
  87: "gm_lead_8_bass_lead",

  // Synth pad (88–95)
  88: "gm_pad_new_age",
  89: "gm_pad_warm",
  90: "gm_pad_poly",
  91: "gm_pad_choir",
  92: "gm_pad_bowed",
  93: "gm_pad_metallic",
  94: "gm_pad_halo",
  95: "gm_pad_sweep",

  // Synth effects (96–103)
  96: "gm_fx_rain",
  97: "gm_fx_soundtrack",
  98: "gm_fx_crystal",
  99: "gm_fx_atmosphere",
  100: "gm_fx_brightness",
  101: "gm_fx_goblins",
  102: "gm_fx_echoes",
  103: "gm_fx_sci_fi",

  // Ethnic (104–111)
  104: "gm_sitar",
  105: "gm_banjo",
  106: "gm_shamisen",
  107: "gm_koto",
  108: "gm_kalimba",
  109: "gm_bagpipe",
  110: "gm_fiddle",
  111: "gm_shanai",

  // Percussive (112–119)
  112: "gm_tinkle_bell",
  113: "gm_agogo",
  114: "gm_steel_drums",
  115: "gm_woodblock",
  116: "gm_taiko_drum",
  117: "gm_melodic_tom",
  118: "gm_synth_drum",
  119: "gm_reverse_cymbal",

  // Sound effects (120–127) — rarely in scored MIDI, fallback to piano
  120: "gm_piano",
  121: "gm_piano",
  122: "gm_piano",
  123: "gm_piano",
  124: "gm_piano",
  125: "gm_piano",
  126: "gm_piano",
  127: "gm_piano",
};

// GM family names ordered by index (program / 8).
export const GM_FAMILY_NAMES = [
  "piano",
  "chromatic percussion",
  "organ",
  "guitar",
  "bass",
  "strings",
  "ensemble",
  "brass",
  "reed",
  "pipe",
  "synth lead",
  "synth pad",
  "synth effects",
  "ethnic",
  "percussive",
  "sound effects",
];

// Family fallback: when a specific GM program's Strudel name doesn't resolve,
// fall back to the family representative.
export const GM_FAMILY_FALLBACK = {
  piano: "gm_piano",
  "chromatic percussion": "gm_vibraphone",
  organ: "gm_drawbar_organ",
  guitar: "gm_acoustic_guitar_nylon",
  bass: "gm_acoustic_bass",
  strings: "gm_string_ensemble_1",
  ensemble: "gm_string_ensemble_1",
  brass: "gm_brass_section",
  reed: "gm_alto_sax",
  pipe: "gm_flute",
  "synth lead": "gm_lead_2_sawtooth",
  "synth pad": "gm_pad_warm",
  "synth effects": "gm_piano",
  ethnic: "gm_piano",
  percussive: "gm_piano",
  "sound effects": "gm_piano",
};

// GM drum map: MIDI note number → Strudel sample name.
// Channel 10 drums, standard GM percussion key map.
export const GM_DRUM_MAP = {
  27: "hq", // High Q (electronic perc)
  35: "bd",
  36: "bd", // Acoustic / Electric Bass Drum
  37: "rim",
  38: "sd", // Acoustic Snare
  39: "cp", // Hand Clap
  40: "sd", // Electric Snare
  41: "lt", // Low Floor Tom
  42: "hh", // Closed Hi-Hat
  43: "lt", // High Floor Tom
  44: "hh", // Pedal Hi-Hat
  45: "mt", // Low Tom
  46: "oh", // Open Hi-Hat
  47: "mt", // Low-Mid Tom
  48: "mt", // Hi-Mid Tom
  49: "cr", // Crash Cymbal 1
  50: "ht", // High Tom
  51: "ride", // Ride Cymbal 1
  52: "cr", // Chinese Cymbal
  53: "ride", // Ride Bell
  54: "tamb", // Tambourine
  55: "cr", // Splash Cymbal
  56: "cb", // Cowbell
  57: "cr", // Crash Cymbal 2
  59: "ride", // Ride Cymbal 2
  60: "ht", // Hi Bongo
  61: "lt", // Low Bongo
  62: "ht", // Mute Hi Conga
  63: "mt", // Open Hi Conga
  64: "lt", // Low Conga
  65: "ht", // High Timbale
  66: "lt", // Low Timbale
  69: "cb", // Cabasa → cowbell as closest
  70: "rim", // Maracas → rim as closest
  75: "hh", // Claves → closed hh as closest percussive hit
  76: "cb", // Hi Wood Block
  77: "cb", // Low Wood Block
};

// Resolve a GM program number to a Strudel sound name.
// Returns the direct mapping, or the family fallback, or "gm_piano".
export function resolveGmInstrument(programNumber) {
  return GM_INSTRUMENT_MAP[programNumber] ?? "gm_piano";
}

// Resolve a GM drum MIDI note to a Strudel sample name, or null if unmapped.
export function resolveGmDrum(midiNote) {
  return GM_DRUM_MAP[midiNote] ?? null;
}
