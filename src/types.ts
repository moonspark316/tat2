export interface PadMeta {
  id: string;
  title: string;
  color: ColorName;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  theme?: string;
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

export type ColorName =
  | "amber"
  | "orange"
  | "red"
  | "purple"
  | "blue"
  | "teal"
  | "green";
