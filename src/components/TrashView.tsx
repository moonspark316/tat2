import { useEffect, useMemo, useState } from "react";
import type { TrashEntry } from "../types";
import { deleteTrash, listTrash } from "../storage";
import { swatch } from "../palette";
import { formatRevision } from "../lib/text";

interface TrashViewProps {
  onRestore: (id: string) => void | Promise<void>;
  onClose: () => void;
}

export function TrashView({ onRestore, onClose }: TrashViewProps) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const now = useMemo(() => Date.now(), []);

  const reload = () => listTrash().then(setEntries);
  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search" onClick={(e) => e.stopPropagation()}>
        <div className="trash-head">Trash</div>
        <div className="search-results">
          {entries.length === 0 ? (
            <div className="search-empty">Trash is empty</div>
          ) : (
            entries.map((e) => (
              <div key={e.meta.id} className="trash-row">
                <span
                  className="hit-dot"
                  style={{ background: swatch(e.meta.color).dot }}
                />
                <span className="hit-label">
                  {e.meta.title && e.meta.title !== "Sketchpad"
                    ? e.meta.title
                    : "Sketchpad"}
                </span>
                <span className="hit-snippet">
                  deleted {formatRevision(e.deletedAt, now)}
                </span>
                <button onClick={() => void onRestore(e.meta.id)}>Restore</button>
                <button
                  className="danger"
                  onClick={async () => {
                    await deleteTrash(e.meta.id);
                    void reload();
                  }}
                  title="Delete permanently"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
