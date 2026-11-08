// R4 (Master Corrections section 4, reading rules for the loader): `santiago-handover/` is the master's old folder name
// (frontend-map.js lines 22 to 25). A path written `santiago-handover/<path>` is read as the master path `<path>`. It
// appears in every form's `spec` field, FRONTEND-SPEC.md lines 11, 449, 473, 481 and 810, and PROFESSION-MAP.md lines
// 746 and 776.
//
// R4 is a reading rule, not a correction of the flows: no step of master-A.json or master-B.json and no trade file names
// the old folder, so it changes no compiled line and runs as no correction (it has no MC tag). It is applied where a
// path is read: masterPath() below, for the forms' `spec` fields and any other path the build reads.

/** The master's old folder name, as the old paths write it. */
export const OLD_MASTER_FOLDER = "santiago-handover/";

/** The master path a path names: what follows the old folder name where it has one, else the path as written. */
export function masterPath(path: string): string {
  const at = path.lastIndexOf(OLD_MASTER_FOLDER);
  return at < 0 ? path : path.slice(at + OLD_MASTER_FOLDER.length);
}

/** Does the text name the old folder? */
export function namesOldFolder(text: string): boolean {
  return text.includes(OLD_MASTER_FOLDER);
}
