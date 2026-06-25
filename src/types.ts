export interface PadMeta {
  id: string;
  title: string;
  color: ColorName;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type ThemeMode = "system" | "light" | "dark";

export interface Settings {
  theme?: ThemeMode;
  fontSize?: number;
  globalShortcut?: string;
}

export interface Index {
  version: number;
  activePadId: string | null;
  pads: PadMeta[];
  settings: Settings;
}

export interface Workspace {
  index: Index;
  contents: Record<string, string>;
}

export interface TrashEntry {
  meta: PadMeta;
  deletedAt: number;
}

export interface RestoredPad {
  meta: PadMeta;
  content: string;
}

/**
 * Lifecycle of a background app update. Deliberately quiet — the UI only ever
 * surfaces the terminal `ready` state (a tiny "restart to update" pill) and,
 * on a *manual* check, the transient `checking` / `none` states. There is no
 * persistent "you're behind" badge, in keeping with the app's non-nagging ethos.
 */
export type UpdateStatus =
  | "idle" // nothing happening (no update found on the silent launch check)
  | "checking" // a check is in flight (only shown for manual checks)
  | "downloading" // an update was found and is downloading in the background
  | "ready" // downloaded + verified; restart to apply
  | "none" // manual check completed: already up to date
  | "error"; // check/download failed (logged; never shown on the silent path)

export interface UpdateState {
  status: UpdateStatus;
  /** The available version once an update is found (e.g. "1.1.0"). */
  version: string | null;
}

export type ColorName =
  | "amber"
  | "orange"
  | "red"
  | "purple"
  | "blue"
  | "teal"
  | "green";
