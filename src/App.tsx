import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { swatch, themeVars } from "./palette";
import { useWorkspace } from "./hooks/useWorkspace";
import { TopBar } from "./components/TopBar";
import { Editor } from "./components/Editor";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { FindBar } from "./components/FindBar";
import { SearchOverlay } from "./components/SearchOverlay";
import { RevisionBrowser } from "./components/RevisionBrowser";
import {
  exportPad,
  hidePopover,
  importFile,
  quitApp,
  setPinned,
} from "./storage";
import "./App.css";

const BEFORE_QUIT_EVENT = "tat2://before-quit";

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export default function App() {
  const ws = useWorkspace();
  const [showSettings, setShowSettings] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pinned, setPinnedState] = useState(false);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const [findFocus, setFindFocus] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelect = useRef<{ start: number; end: number } | null>(null);

  // Latest-value refs so the global key handler can subscribe once.
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const showSettingsRef = useRef(showSettings);
  showSettingsRef.current = showSettings;
  const showFindRef = useRef(showFind);
  showFindRef.current = showFind;
  const showSearchRef = useRef(showSearch);
  showSearchRef.current = showSearch;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

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

  // ---- Track the system color scheme for theme="system" ----
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ---- Apply the active pad's color theme (light or dark) ----
  const sw = swatch(ws.activePad?.color ?? "amber");
  const themeMode = ws.index?.settings.theme ?? "system";
  const dark = themeMode === "dark" || (themeMode === "system" && systemDark);
  useEffect(() => {
    const v = themeVars(sw, dark);
    const root = document.documentElement;
    root.style.setProperty("--bg", v.bg);
    root.style.setProperty("--chrome", v.chrome);
    root.style.setProperty("--ink", v.ink);
    root.style.setProperty("--dot", v.dot);
    root.style.colorScheme = dark ? "dark" : "light";
  }, [sw, dark]);

  // ---- Focus the editor whenever the active pad changes ----
  useEffect(() => {
    if (!showFind && !showSearch) textareaRef.current?.focus();
  }, [ws.activeId, showFind, showSearch]);

  /** Scroll a range into view + highlight it WITHOUT stealing focus (find). */
  const revealRange = useCallback((start: number, end: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.setSelectionRange(start, end);
    const line = ta.value.slice(0, start).split("\n").length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    const lineHeight = Number.isFinite(lh) ? lh : 22;
    ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 2);
  }, []);

  /** Move the editor caret to a range and focus it (cross-pad jump). */
  const selectRange = useCallback(
    (start: number, end: number) => {
      revealRange(start, end);
      textareaRef.current?.focus();
    },
    [revealRange],
  );

  // ---- Apply a pending selection after switching pads (cross-pad jump) ----
  useEffect(() => {
    if (!pendingSelect.current) return;
    const { start, end } = pendingSelect.current;
    pendingSelect.current = null;
    requestAnimationFrame(() => selectRange(start, end));
  }, [ws.activeId, selectRange]);

  // ---- Global keyboard shortcuts (subscribed once) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Chrome inputs (rename, settings, find, search) handle their own keys.
      // The main editor is a <textarea>, so shortcuts still work while typing.
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (showSearchRef.current) setShowSearch(false);
        else if (showFindRef.current) {
          setShowFind(false);
          textareaRef.current?.focus();
        } else if (showSettingsRef.current) setShowSettings(false);
        else void hidePopover();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const w = wsRef.current;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (e.shiftKey) {
          setShowSearch(true);
        } else {
          // Open (or, if already open, re-focus) the find bar.
          setShowFind(true);
          setFindFocus((n) => n + 1);
        }
      } else if (e.key === "n" || e.key === "N") {
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

  // Native file dialogs steal focus; pin the popover so it doesn't auto-hide,
  // then restore the user's pin preference afterwards.
  const handleExport = async () => {
    if (!ws.activePad) return;
    const raw =
      ws.activePad.title && ws.activePad.title !== "Sketchpad"
        ? ws.activePad.title
        : "sketchpad";
    const name = raw.replace(/[^\w.-]+/g, "_") || "sketchpad";
    // Persist the latest keystrokes first — export reads from disk.
    await ws.flush();
    await setPinned(true);
    try {
      const dest = await save({
        defaultPath: `${name}.md`,
        filters: [{ name: "Markdown / Text", extensions: ["md", "txt"] }],
      });
      if (dest) await exportPad(ws.activePad.id, dest);
    } finally {
      await setPinned(pinnedRef.current);
    }
  };

  const handleImport = async () => {
    await setPinned(true);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Text", extensions: ["md", "markdown", "txt"] }],
      });
      if (typeof path === "string") {
        const content = await importFile(path);
        const base = path.split(/[\\/]/).pop() ?? "Imported";
        ws.importPad(base.replace(/\.[^.]+$/, ""), content);
      }
    } finally {
      await setPinned(pinnedRef.current);
    }
  };

  const onJump = (padId: string, offset: number, length: number) => {
    setShowSearch(false);
    if (padId === ws.activeId) {
      selectRange(offset, offset + length);
    } else {
      pendingSelect.current = { start: offset, end: offset + length };
      ws.switchPad(padId);
    }
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
        onHistory={() => setShowHistory(true)}
        onToggleSettings={() => setShowSettings((v) => !v)}
        onClose={closeWindow}
      />

      {showSettings && ws.activePad ? (
        <SettingsPanel
          pad={ws.activePad}
          fontSize={fontSize}
          theme={themeMode}
          canDelete={ws.index.pads.length > 1}
          onRename={(t) => ws.renamePad(ws.activePad!.id, t)}
          onRecolor={(c) => ws.recolorPad(ws.activePad!.id, c)}
          onFontSize={ws.setFontSize}
          onTheme={ws.setTheme}
          onExport={handleExport}
          onImport={handleImport}
          onDelete={() => {
            ws.removePad(ws.activePad!.id);
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      ) : null}

      {showFind ? (
        <FindBar
          content={ws.activeContent}
          focusSignal={findFocus}
          onSelect={revealRange}
          onClose={() => {
            setShowFind(false);
            textareaRef.current?.focus();
          }}
        />
      ) : null}

      <Editor
        ref={textareaRef}
        value={ws.activeContent}
        fontSize={fontSize}
        onChange={ws.edit}
      />

      <StatusBar content={ws.activeContent} />

      {showSearch ? (
        <SearchOverlay
          pads={ws.index.pads}
          contents={ws.contents}
          onJump={onJump}
          onClose={() => setShowSearch(false)}
        />
      ) : null}

      {showHistory && ws.activePad ? (
        <RevisionBrowser
          padId={ws.activePad.id}
          currentContent={ws.activeContent}
          onRestore={ws.restoreContent}
          onClose={() => setShowHistory(false)}
        />
      ) : null}
    </div>
  );
}
