import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { swatch, themeVars } from "./palette";
import { useWorkspace } from "./hooks/useWorkspace";
import { TopBar } from "./components/TopBar";
import { Editor } from "./components/Editor";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { FindBar } from "./components/FindBar";
import { SearchOverlay } from "./components/SearchOverlay";
import { RevisionBrowser } from "./components/RevisionBrowser";
import { TrashView } from "./components/TrashView";
import { MarkdownView } from "./components/MarkdownView";
import {
  exportPad,
  hidePopover,
  importFile,
  quitApp,
  setPinned,
  setShortcut,
} from "./storage";
import { defaultShortcut } from "./lib/shortcut";
import "./App.css";

const BEFORE_QUIT_EVENT = "tat2://before-quit";

/** The mutually-exclusive full-screen overlays. */
type Overlay = "none" | "settings" | "search" | "history" | "trash";

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export default function App() {
  const ws = useWorkspace();
  // The full-screen overlays are mutually exclusive — exactly one (or none) is
  // up at a time — so they're one piece of state, not N booleans that can drift
  // into illegal "two open at once" combos. Find is deliberately separate: it's
  // a non-modal bar that floats over the editor, not an overlay.
  const [modal, setModal] = useState<Overlay>("none");
  const [showFind, setShowFind] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pinned, setPinnedState] = useState(false);
  const [autostartOn, setAutostartOn] = useState(false);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const [findFocus, setFindFocus] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelect = useRef<{ start: number; end: number } | null>(null);

  // Latest-value refs so the global key handler can subscribe once.
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const showFindRef = useRef(showFind);
  showFindRef.current = showFind;
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

  // ---- Reflect the current autostart (launch-at-login) state ----
  useEffect(() => {
    isAutostartEnabled()
      .then(setAutostartOn)
      .catch(() => setAutostartOn(false));
  }, []);

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
    // Don't yank focus out of an open overlay (e.g. the search input) or the
    // find bar when switching pads underneath them.
    if (!showFind && modal === "none") textareaRef.current?.focus();
  }, [ws.activeId, showFind, modal]);

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
        // Close the find bar first (it floats over an overlay-free editor),
        // then any open overlay, then hide the popover.
        if (showFindRef.current) {
          setShowFind(false);
          textareaRef.current?.focus();
        } else if (modalRef.current !== "none") setModal("none");
        else void hidePopover();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Don't fire editor shortcuts while an overlay is up (it sits on top;
      // mutating the workspace behind it is surprising). Find is non-modal, so
      // it doesn't block them.
      if (modalRef.current !== "none") return;
      const w = wsRef.current;
      // Match on physical key position (e.code), not the produced character, so
      // shortcuts survive non-US layouts (AZERTY/QWERTZ) and a held Shift, where
      // e.key for the digit/bracket row is "!"/"&"/"ü" etc.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (e.code === "KeyF") {
        e.preventDefault();
        if (e.shiftKey) {
          setShowFind(false);
          setModal("search");
        } else {
          // Open (or, if already open, re-focus) the find bar.
          setShowFind(true);
          setFindFocus((n) => n + 1);
        }
      } else if (e.code === "KeyN") {
        e.preventDefault();
        w.addPad();
      } else if (e.code === "BracketLeft") {
        e.preventDefault();
        w.switchByOffset(-1);
      } else if (e.code === "BracketRight") {
        e.preventDefault();
        w.switchByOffset(1);
      } else if (digit) {
        e.preventDefault();
        w.switchByPosition(Number(digit[1]) - 1);
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

  // Register the new combo first; only persist it if the OS accepted it.
  const handleSetShortcut = async (accelerator: string) => {
    await setShortcut(accelerator);
    ws.setGlobalShortcut(accelerator);
  };

  const toggleAutostart = async () => {
    try {
      if (autostartOn) {
        await disableAutostart();
        setAutostartOn(false);
      } else {
        await enableAutostart();
        setAutostartOn(true);
      }
    } catch {
      // Reflect actual state if the OS rejected the change.
      isAutostartEnabled().then(setAutostartOn).catch(() => {});
    }
  };

  const onJump = (padId: string, offset: number, length: number) => {
    setModal("none");
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
        onHistory={() => {
          setShowFind(false);
          setModal("history");
        }}
        preview={preview}
        onTogglePreview={() => setPreview((v) => !v)}
        onToggleSettings={() => {
          setShowFind(false);
          setModal((m) => (m === "settings" ? "none" : "settings"));
        }}
        onClose={closeWindow}
      />

      {modal === "settings" && ws.activePad ? (
        <SettingsPanel
          pad={ws.activePad}
          fontSize={fontSize}
          theme={themeMode}
          canDelete={ws.index.pads.length > 1}
          onRename={(t) => ws.renamePad(ws.activePad!.id, t)}
          onRecolor={(c) => ws.recolorPad(ws.activePad!.id, c)}
          onFontSize={ws.setFontSize}
          onTheme={ws.setTheme}
          shortcut={ws.index.settings.globalShortcut ?? defaultShortcut}
          onSetShortcut={handleSetShortcut}
          onExport={handleExport}
          onImport={handleImport}
          autostartOn={autostartOn}
          onToggleAutostart={toggleAutostart}
          onTrash={() => setModal("trash")}
          onDelete={() => {
            ws.removePad(ws.activePad!.id);
            setModal("none");
          }}
          onClose={() => setModal("none")}
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

      {preview ? (
        <MarkdownView content={ws.activeContent} fontSize={fontSize} />
      ) : (
        <Editor
          ref={textareaRef}
          value={ws.activeContent}
          fontSize={fontSize}
          onChange={ws.edit}
        />
      )}

      <StatusBar content={ws.activeContent} />

      {modal === "search" ? (
        <SearchOverlay
          pads={ws.index.pads}
          contents={ws.contents}
          onJump={onJump}
          onClose={() => setModal("none")}
        />
      ) : null}

      {modal === "history" && ws.activePad ? (
        <RevisionBrowser
          padId={ws.activePad.id}
          currentContent={ws.activeContent}
          onRestore={ws.restoreContent}
          onClose={() => setModal("none")}
        />
      ) : null}

      {modal === "trash" ? (
        <TrashView
          onRestore={async (id) => {
            await ws.restoreFromTrash(id);
            setModal("none");
          }}
          onClose={() => setModal("none")}
        />
      ) : null}
    </div>
  );
}
