import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Index, PadMeta } from "./types";
import { swatch, nextColor, PALETTE } from "./palette";
import {
  AutoSaver,
  deletePad as deletePadOnDisk,
  loadWorkspace,
  saveIndex,
  savePadNow,
} from "./storage";
import "./App.css";

const appWindow = getCurrentWindow();

function computeStats(text: string) {
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split("\n").length : 0;
  return { chars, words, lines };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 40) : "Empty pad";
}

export default function App() {
  const [index, setIndex] = useState<Index | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [showSettings, setShowSettings] = useState(false);
  const saver = useRef(new AutoSaver(400));
  const loaded = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ---- Initial load ----
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadWorkspace().then((ws) => {
      setIndex(ws.index);
      setContents(ws.contents);
    });
  }, []);

  // ---- Flush pending writes when the popover loses focus / closes ----
  useEffect(() => {
    const flush = () => void saver.current.flushAll();
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  const activeId = index?.activePadId ?? null;
  const activePad: PadMeta | null = useMemo(
    () => index?.pads.find((p) => p.id === activeId) ?? null,
    [index, activeId],
  );
  const activeContent = activeId ? (contents[activeId] ?? "") : "";
  const sw = swatch(activePad?.color ?? "amber");

  // ---- Apply the active pad's color theme to the whole window ----
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--bg", sw.bg);
    root.style.setProperty("--chrome", sw.chrome);
    root.style.setProperty("--ink", sw.ink);
    root.style.setProperty("--dot", sw.dot);
  }, [sw]);

  // ---- Focus the editor whenever the active pad changes ----
  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeId]);

  const persistIndex = useCallback((next: Index) => {
    setIndex(next);
    void saveIndex(next);
  }, []);

  const onEdit = (value: string) => {
    if (!activeId || !index) return;
    setContents((c) => ({ ...c, [activeId]: value }));
    saver.current.queue(activeId, value);
    const now = Date.now();
    setIndex((idx) =>
      idx
        ? {
            ...idx,
            pads: idx.pads.map((p) =>
              p.id === activeId ? { ...p, updatedAt: now } : p,
            ),
          }
        : idx,
    );
  };

  const switchPad = (id: string) => {
    if (!index || id === activeId) return;
    void saver.current.flushAll();
    persistIndex({ ...index, activePadId: id });
  };

  const addPad = () => {
    if (!index) return;
    const used = index.pads.map((p) => p.color);
    const now = Date.now();
    const id = `pad-${now}`;
    const pad: PadMeta = {
      id,
      title: "Sketchpad",
      color: nextColor(used),
      order: index.pads.length,
      createdAt: now,
      updatedAt: now,
    };
    setContents((c) => ({ ...c, [id]: "" }));
    void savePadNow(id, "");
    persistIndex({ ...index, pads: [...index.pads, pad], activePadId: id });
  };

  const removePad = (id: string) => {
    if (!index || index.pads.length <= 1) return;
    const remaining = index.pads.filter((p) => p.id !== id);
    const nextActive = activeId === id ? (remaining[0]?.id ?? null) : activeId;
    void deletePadOnDisk(id);
    setContents((c) => {
      const { [id]: _drop, ...rest } = c;
      return rest;
    });
    persistIndex({ ...index, pads: remaining, activePadId: nextActive });
    setShowSettings(false);
  };

  const renamePad = (id: string, title: string) => {
    if (!index) return;
    persistIndex({
      ...index,
      pads: index.pads.map((p) => (p.id === id ? { ...p, title } : p)),
    });
  };

  const recolorPad = (id: string, color: PadMeta["color"]) => {
    if (!index) return;
    persistIndex({
      ...index,
      pads: index.pads.map((p) => (p.id === id ? { ...p, color } : p)),
    });
  };

  const setFontSize = (size: number) => {
    if (!index) return;
    persistIndex({
      ...index,
      settings: {
        ...index.settings,
        fontSize: Math.min(28, Math.max(11, size)),
      },
    });
  };

  const closeWindow = () => {
    void saver.current.flushAll().then(() => appWindow.hide());
  };

  if (!index) {
    return <div className="boot" />;
  }

  const fontSize = index.settings.fontSize ?? 15;
  const stats = computeStats(activeContent);
  const nf = (n: number) => n.toLocaleString();

  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <button
          className="icon-btn close"
          onClick={closeWindow}
          title="Hide (reopen with the global shortcut)"
        >
          ×
        </button>

        <div className="dots">
          {index.pads.map((p) => {
            const s = swatch(p.color);
            const active = p.id === activeId;
            return (
              <button
                key={p.id}
                className={`dot ${active ? "active" : ""}`}
                style={{ ["--this" as string]: s.dot }}
                title={
                  p.title && p.title !== "Sketchpad"
                    ? p.title
                    : firstLine(contents[p.id] ?? "")
                }
                onClick={() => switchPad(p.id)}
              />
            );
          })}
          <button className="dot add" onClick={addPad} title="New sketchpad">
            +
          </button>
        </div>

        <button
          className="icon-btn gear"
          onClick={() => setShowSettings((v) => !v)}
          title="Settings"
        >
          ⚙
        </button>
      </header>

      {showSettings && activePad ? (
        <SettingsPanel
          pad={activePad}
          fontSize={fontSize}
          canDelete={index.pads.length > 1}
          onRename={(t) => renamePad(activePad.id, t)}
          onRecolor={(c) => recolorPad(activePad.id, c)}
          onFontSize={setFontSize}
          onDelete={() => removePad(activePad.id)}
          onClose={() => setShowSettings(false)}
        />
      ) : null}

      <textarea
        ref={textareaRef}
        className="editor"
        style={{ fontSize }}
        value={activeContent}
        spellCheck={false}
        placeholder="Start sketching…"
        onChange={(e) => onEdit(e.target.value)}
      />

      <footer className="statusbar">
        <span className="stats">
          {nf(stats.lines)} lines · {nf(stats.words)} words ·{" "}
          {nf(stats.chars)} characters
        </span>
      </footer>
    </div>
  );
}

interface SettingsProps {
  pad: PadMeta;
  fontSize: number;
  canDelete: boolean;
  onRename: (t: string) => void;
  onRecolor: (c: PadMeta["color"]) => void;
  onFontSize: (n: number) => void;
  onDelete: () => void;
  onClose: () => void;
}

function SettingsPanel({
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
