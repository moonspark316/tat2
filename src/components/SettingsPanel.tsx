import { useEffect, useState } from "react";
import type { ColorName, PadMeta, ThemeMode, UpdateStatus } from "../types";
import { PALETTE } from "../palette";
import { buildAccelerator, displayShortcut } from "../lib/shortcut";

const THEMES: ThemeMode[] = ["system", "light", "dark"];

interface SettingsProps {
  pad: PadMeta;
  fontSize: number;
  theme: ThemeMode;
  canDelete: boolean;
  onRename: (t: string) => void;
  onRecolor: (c: ColorName) => void;
  onFontSize: (n: number) => void;
  onTheme: (t: ThemeMode) => void;
  shortcut: string;
  onSetShortcut: (accelerator: string) => Promise<void>;
  onExport: () => void;
  onImport: () => void;
  autostartOn: boolean;
  onToggleAutostart: () => void;
  updateStatus: UpdateStatus;
  updateVersion: string | null;
  onCheckUpdate: () => void;
  onRestartUpdate: () => void;
  onTrash: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function SettingsPanel({
  pad,
  fontSize,
  theme,
  canDelete,
  onRename,
  onRecolor,
  onFontSize,
  onTheme,
  shortcut,
  onSetShortcut,
  onExport,
  onImport,
  autostartOn,
  onToggleAutostart,
  updateStatus,
  updateVersion,
  onCheckUpdate,
  onRestartUpdate,
  onTrash,
  onDelete,
  onClose,
}: SettingsProps) {
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const accel = buildAccelerator(e);
      if (!accel) return; // wait for a full combo
      setRecording(false);
      onSetShortcut(accel)
        .then(() => setShortcutError(null))
        .catch((err) => setShortcutError(String(err)));
    };
    window.addEventListener("keydown", onKey, true);
    // Don't trap keystrokes forever if the user wanders off.
    const timeout = setTimeout(() => setRecording(false), 5000);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(timeout);
    };
  }, [recording, onSetShortcut]);
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
        <span>Theme</span>
        <div className="segmented">
          {THEMES.map((t) => (
            <button
              key={t}
              className={theme === t ? "on" : ""}
              onClick={() => onTheme(t)}
            >
              {t}
            </button>
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

      <div className="row">
        <span>Shortcut</span>
        <button
          className={`shortcut-btn ${recording ? "recording" : ""}`}
          onClick={() => {
            setShortcutError(null);
            setRecording((r) => !r);
          }}
          title="Click, then press a key combo (Esc to cancel)"
        >
          {recording ? "Press keys…" : displayShortcut(shortcut)}
        </button>
      </div>
      {shortcutError ? (
        <div className="row shortcut-error">{shortcutError}</div>
      ) : null}

      <div className="row">
        <span>Launch at login</span>
        <button
          className={`toggle ${autostartOn ? "on" : ""}`}
          onClick={onToggleAutostart}
        >
          {autostartOn ? "On" : "Off"}
        </button>
      </div>

      <div className="row">
        <span>Updates</span>
        <UpdateRow
          status={updateStatus}
          version={updateVersion}
          onCheck={onCheckUpdate}
          onRestart={onRestartUpdate}
        />
      </div>

      <div className="row">
        <span>File</span>
        <div className="stepper">
          <button onClick={onExport}>Export…</button>
          <button onClick={onImport}>Import…</button>
        </div>
      </div>

      <div className="row">
        <span>Trash</span>
        <button onClick={onTrash}>Open Trash…</button>
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

/**
 * The manual update control. Unlike the silent launch check, this is allowed to
 * show transient feedback ("Checking…", "Up to date") because the user clicked.
 * When a build is staged it offers a Restart button; everything else collapses
 * back to a plain "Check for updates".
 */
function UpdateRow({
  status,
  version,
  onCheck,
  onRestart,
}: {
  status: UpdateStatus;
  version: string | null;
  onCheck: () => void;
  onRestart: () => void;
}) {
  if (status === "ready") {
    return (
      <button
        className="update-action ready"
        onClick={onRestart}
        title={version ? `Restart to update to ${version}` : "Restart to update"}
      >
        Restart to update
      </button>
    );
  }

  const busy = status === "checking" || status === "downloading";
  const label =
    status === "checking"
      ? "Checking…"
      : status === "downloading"
        ? "Downloading…"
        : status === "none"
          ? "Up to date"
          : status === "error"
            ? "Try again"
            : "Check for updates";

  return (
    <button className="update-action" onClick={onCheck} disabled={busy}>
      {label}
    </button>
  );
}
