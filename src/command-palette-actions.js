import { buildCommands } from "./ui/command-palette.js";
import { formatCommand } from "./editor/format.js";
import { toggleLabelAtCursor } from "./editor/keymap.js";
import { toggleMute, toggleSolo } from "./editor/track-labels.js";
import {
  toggleComment,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectLine,
} from "@codemirror/commands";
import {
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";

export function buildPaletteCommands({
  editor,
  rightRail,
  leftRail,
  bottomModes,
  saveBtn,
  exportBtn,
  shareBtn,
  onNextTab,
  onPrevTab,
  onCloseActiveTab,
  onToggleVisualsFullWindow,
}) {
  // Same rule as the keymap (editor-setup.js) and the track bar: a mute /
  // solo toggle re-evaluates so it is heard, but with the transport stopped
  // it is only an edit and must not start playback.
  const evaluateIfPlaying = () => {
    if (editor.repl?.scheduler?.started) editor.evaluate();
  };
  return buildCommands({
    onEvaluate: () => editor.evaluate(),
    onStop: () => editor.stop(),
    onSave: import.meta.env.DEV ? () => saveBtn?.click() : null,
    onExportWav: () => exportBtn?.click(),
    onShare: () => shareBtn?.click(),
    onFormatCode: () => formatCommand(editor.editor),
    onToggleComment: () => {
      editor.editor.focus();
      toggleComment(editor.editor);
    },
    onMuteTrack: () =>
      toggleLabelAtCursor(
        editor.editor,
        evaluateIfPlaying,
        toggleMute,
        "input.track-mute",
      ),
    onSoloTrack: () =>
      toggleLabelAtCursor(
        editor.editor,
        evaluateIfPlaying,
        toggleSolo,
        "input.track-solo",
      ),
    onSelectNext: () => {
      editor.editor.focus();
      selectNextOccurrence(editor.editor);
    },
    onSelectAllOccurrences: () => {
      editor.editor.focus();
      selectSelectionMatches(editor.editor);
    },
    onSelectLine: () => {
      editor.editor.focus();
      selectLine(editor.editor);
    },
    onDeleteLine: () => {
      editor.editor.focus();
      deleteLine(editor.editor);
    },
    onMoveLineUp: () => {
      editor.editor.focus();
      moveLineUp(editor.editor);
    },
    onMoveLineDown: () => {
      editor.editor.focus();
      moveLineDown(editor.editor);
    },
    onIndent: () => {
      editor.editor.focus();
      indentMore(editor.editor);
    },
    onDedent: () => {
      editor.editor.focus();
      indentLess(editor.editor);
    },
    onOpenLearn: () => rightRail.activate("learn"),
    onOpenSounds: () => rightRail.activate("sounds"),
    onOpenReference: () => rightRail.activate("reference"),
    onOpenConsole: () => rightRail.activate("console"),
    onOpenExport: () => rightRail.activate("export"),
    onOpenSettings: () => rightRail.activate("settings"),
    onClosePanel: () => rightRail.collapse(),
    onFocusPatterns: () => leftRail.focusSearch(),
    onSwitchToRoll: () => bottomModes.setMode("roll"),
    onSwitchToScope: () => bottomModes.setMode("scope"),
    // Cmd+Shift+B from the palette can't read the editor's cursor (the
    // palette steals focus when it opens), so the palette path
    // intentionally degrades to "just open the browser". The user can
    // then search/scroll. The cursor-aware reveal lives in
    // keymap-universal.js's Mod-Shift-b binding.
    onRevealSound: () => rightRail.activate("sounds"),
    onNextTab,
    onPrevTab,
    onCloseActiveTab,
    onToggleVisualsFullWindow,
  });
}
