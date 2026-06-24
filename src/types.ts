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

export type ColorName =
  | "amber"
  | "orange"
  | "red"
  | "purple"
  | "blue"
  | "teal"
  | "green";
