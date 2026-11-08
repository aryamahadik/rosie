// The shared lists of the modules merged before the shared-list.ts convention (T-149): the guard's keyword list, which
// T-134 builds (compiler/src/msgtext/keywords.ts), and the plug-in key map, which T-143 builds
// (compiler/src/keymap/keymap.ts). The emitter collects this file like any module's shared-list.ts (shared-lists.ts);
// a list a later module gives joins by that module's own shared-list.ts, with no edit here or in the emitter.
import { buildKeyMap } from "../keymap";
import { buildKeywords } from "../msgtext";
import type { SharedListPart } from "./shared-lists";

export const sharedLists: SharedListPart[] = [
  {
    list: "keywords",
    source:
      "T-134: START, HELP and msgtext.js OPTOUT's 16 opt-out words (line 29), CANCEL and CANCELAR flagging the visit (arch 02 line 115)",
    build: buildKeywords,
  },
  {
    list: "keyMap",
    source: "T-143: the trade files' top keys and where each lands (arch 12 line 592; MC R2, R3, C6; Q-39)",
    build: buildKeyMap,
  },
];
