import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { swatch } from "./palette";
import { useWorkspace } from "./hooks/useWorkspace";
import { TopBar } from "./components/TopBar";
import { Editor } from "./components/Editor";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { hidePopover, quitApp, setPinned } from "./storage";
import "./App.css";

const BEFORE_QUIT_EVENT = "tat2://before-quit";

export default function App() {
  const ws = useWorkspace();
  const [showSettings, setShowSettings] = useState(false);
  const [pinned, setPinnedState] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Latest-value refs so the global key handler can subscribe once (no churn
  // on every keystroke) while still seeing current state.
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const showSettingsRef = useRef(showSettings);
  showSettingsRef.current = showSettings;

  // ---- Flush pending writes whenever focus/visibility is lost ----
  useEffect(() => {
    const flush = () => void ws.flush();
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [ws.flush]);

  // ---- Flush + quit when the tray asks us to ----
  useEffect(() => {
    const unlisten = listen(BEFORE_QUIT_EVENT, async () => {
      await ws.flush();
      await quitApp();
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, [ws.flush]);

  // ---- Apply the active pad's color theme to the whole window ----
  const sw = swatch(ws.activePad?.color ?? "amber");
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
  }, [ws.activeId]);

  // ---- Global keyboard shortcuts (subscribed once) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Chrome inputs (pad rename, settings fields) handle their own keys.
      // The main editor is a <textarea>, so shortcuts still work while typing.
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (showSettingsRef.current) setShowSettings(false);
        else void hidePopover();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const w = wsRef.current;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        w.addPad();
      } else if (e.key === "[") {
        e.preventDefault();
        w.switchByOffset(-1);
      } else if (e.key === "]") {
        e.preventDefault();
        w.switchByOffset(1);
      } else if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        w.switchByPosition(Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const togglePin = () => {
    const next = !pinned;
    setPinnedState(next);
    void setPinned(next);
  };

  const closeWindow = () => {
    void ws.flush().then(() => hidePopover());
  };

  if (!ws.ready || !ws.index) {
    return <div className="boot" />;
  }

  const fontSize = ws.index.settings.fontSize ?? 15;

  return (
    <div className="app">
      <TopBar
        pads={ws.index.pads}
        contents={ws.contents}
        activeId={ws.activeId}
        pinned={pinned}
        onSwitch={ws.switchPad}
        onAdd={ws.addPad}
        onRename={ws.renamePad}
        onReorder={ws.reorderPads}
        onTogglePin={togglePin}
        onToggleSettings={() => setShowSettings((v) => !v)}
        onClose={closeWindow}
      />

      {showSettings && ws.activePad ? (
        <SettingsPanel
          pad={ws.activePad}
          fontSize={fontSize}
          canDelete={ws.index.pads.length > 1}
          onRename={(t) => ws.renamePad(ws.activePad!.id, t)}
          onRecolor={(c) => ws.recolorPad(ws.activePad!.id, c)}
          onFontSize={ws.setFontSize}
          onDelete={() => {
            ws.removePad(ws.activePad!.id);
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      ) : null}

      <Editor
        ref={textareaRef}
        value={ws.activeContent}
        fontSize={fontSize}
        onChange={ws.edit}
      />

      <StatusBar content={ws.activeContent} />
    </div>
  );
}
