interface UpdatePillProps {
  /** The version that's downloaded and waiting (e.g. "1.1.0"). */
  version: string | null;
  /** Restart now to apply the update. */
  onRestart: () => void;
  /** Dismiss the pill until the next launch (no nagging). */
  onDismiss: () => void;
}

/**
 * The single, quiet update affordance: a small pill that only appears once a
 * new build is downloaded + verified. "Restart" applies it; "×" dismisses it
 * until next launch. No spinner, no countdown, no version-behind badge.
 */
export function UpdatePill({ version, onRestart, onDismiss }: UpdatePillProps) {
  return (
    <div className="update-pill" role="status">
      <button
        className="update-pill-apply"
        onClick={onRestart}
        title={version ? `Restart to update to ${version}` : "Restart to update"}
      >
        Update ready — restart
      </button>
      <button
        className="update-pill-dismiss"
        onClick={onDismiss}
        title="Dismiss until next launch"
        aria-label="Dismiss update"
      >
        ×
      </button>
    </div>
  );
}
