import type { ColorName, PadMeta } from "../types";
import { PALETTE } from "../palette";

interface SettingsProps {
  pad: PadMeta;
  fontSize: number;
  canDelete: boolean;
  onRename: (t: string) => void;
  onRecolor: (c: ColorName) => void;
  onFontSize: (n: number) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function SettingsPanel({
  pad,
  fontSize,
  canDelete,
  onRename,
  onRecolor,
  onFontSize,
  onDelete,
  onClose,
}: SettingsProps) {
  return (
    <div className="settings">
      <label className="row">
        <span>Name</span>
        <input
          value={pad.title}
          onChange={(e) => onRename(e.target.value)}
          placeholder="Sketchpad"
        />
      </label>

      <div className="row">
        <span>Color</span>
        <div className="swatches">
          {PALETTE.map((s) => (
            <button
              key={s.name}
              className={`swatch ${s.name === pad.color ? "on" : ""}`}
              style={{ background: s.dot }}
              onClick={() => onRecolor(s.name)}
              title={s.name}
            />
          ))}
        </div>
      </div>

      <div className="row">
        <span>Text size</span>
        <div className="stepper">
          <button onClick={() => onFontSize(fontSize - 1)}>A−</button>
          <span>{fontSize}</span>
          <button onClick={() => onFontSize(fontSize + 1)}>A+</button>
        </div>
      </div>

      <div className="row actions">
        <button
          className="danger"
          disabled={!canDelete}
          onClick={onDelete}
          title={
            canDelete ? "Delete this sketchpad" : "Keep at least one sketchpad"
          }
        >
          Delete sketchpad
        </button>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
