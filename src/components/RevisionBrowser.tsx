import { useEffect, useMemo, useState } from "react";
import { listRevisions, readRevision } from "../storage";
import { formatRevision } from "../lib/text";
import { diffLines } from "../lib/diff";

interface RevisionBrowserProps {
  padId: string;
  currentContent: string;
  onRestore: (content: string) => void | Promise<void>;
  onClose: () => void;
}

export function RevisionBrowser({
  padId,
  currentContent,
  onRestore,
  onClose,
}: RevisionBrowserProps) {
  const [revisions, setRevisions] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [revContent, setRevContent] = useState("");
  const [mode, setMode] = useState<"preview" | "diff">("diff");
  const now = useMemo(() => Date.now(), []);

  // Avoid the O(n*m) diff on very large pads (main-thread perf cliff).
  const MAX_DIFF_LINES = 2000;
  const tooLarge =
    revContent.split("\n").length > MAX_DIFF_LINES ||
    currentContent.split("\n").length > MAX_DIFF_LINES;
  const effectiveMode = tooLarge ? "preview" : mode;

  useEffect(() => {
    let alive = true;
    listRevisions(padId).then((ts) => {
      if (!alive) return;
      const sorted = [...ts].sort((a, b) => b - a); // newest first
      setRevisions(sorted);
      setSelected(sorted[0] ?? null);
    });
    return () => {
      alive = false;
    };
  }, [padId]);

  useEffect(() => {
    if (selected === null) {
      setRevContent("");
      return;
    }
    let alive = true;
    readRevision(padId, selected).then((c) => {
      if (alive) setRevContent(c);
    });
    return () => {
      alive = false;
    };
  }, [padId, selected]);

  const diff = useMemo(
    () => (tooLarge ? [] : diffLines(revContent, currentContent)),
    [revContent, currentContent, tooLarge],
  );

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="revbrowser" onClick={(e) => e.stopPropagation()}>
        <div className="rev-list">
          <div className="rev-list-head">History</div>
          {revisions.length === 0 ? (
            <div className="search-empty">No revisions yet</div>
          ) : (
            revisions.map((ts) => (
              <button
                key={ts}
                className={`rev-item ${ts === selected ? "active" : ""}`}
                onClick={() => setSelected(ts)}
              >
                {formatRevision(ts, now)}
              </button>
            ))
          )}
        </div>

        <div className="rev-detail">
          <div className="rev-toolbar">
            <div className="segmented">
              <button
                className={effectiveMode === "diff" ? "on" : ""}
                disabled={tooLarge}
                title={tooLarge ? "Pad too large to diff" : undefined}
                onClick={() => setMode("diff")}
              >
                Diff
              </button>
              <button
                className={effectiveMode === "preview" ? "on" : ""}
                onClick={() => setMode("preview")}
              >
                Preview
              </button>
            </div>
            <div className="rev-actions">
              <button
                disabled={selected === null}
                onClick={() => {
                  void Promise.resolve(onRestore(revContent)).then(onClose);
                }}
                title="Replace current content with this revision (current is snapshotted first)"
              >
                Restore
              </button>
              <button onClick={onClose}>Close</button>
            </div>
          </div>

          <div className="rev-body">
            {selected === null ? (
              <div className="search-empty">Select a revision</div>
            ) : effectiveMode === "preview" ? (
              <pre className="rev-pre">{revContent}</pre>
            ) : (
              <pre className="rev-pre">
                {diff.map((l, i) => (
                  <div key={i} className={`diff-${l.type}`}>
                    {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
                    {l.text}
                  </div>
                ))}
              </pre>
            )}
          </div>
          <div className="rev-hint">
            {tooLarge
              ? "Pad too large to diff — showing revision contents"
              : effectiveMode === "diff"
                ? "Showing changes from this revision → current"
                : "Revision contents"}
          </div>
        </div>
      </div>
    </div>
  );
}
