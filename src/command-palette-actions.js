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
}) {
  return buildCommands({
    onEvaluate: () => editor.evaluate(),
    onStop: () => editor.stop(),
    onSave: () => saveBtn?.click(),
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
        () => editor.evaluate(),
        toggleMute,
        "input.track-mute",
      ),
    onSoloTrack: () =>
      toggleLabelAtCursor(
        editor.editor,
        () => editor.evaluate(),
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
    onOpenSetup: () => rightRail.activate("setup"),
    onClosePanel: () => rightRail.collapse(),
    onFocusPatterns: () => leftRail.focusSearch(),
    onSwitchToRoll: () => bottomModes.setMode("roll"),
    onSwitchToScope: () => {
      bottomModes.enableScope();
      bottomModes.setMode("scope");
    },
  });
}
