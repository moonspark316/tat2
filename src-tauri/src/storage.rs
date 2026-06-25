//! Local-first, never-fail storage for Tat2.
//!
//! Source of truth is plain Markdown on disk so a pad is always recoverable
//! with any text editor. Writes are atomic (temp file + rename) so a crash or
//! power loss can never leave a half-written / corrupt pad. Every meaningful
//! change is also appended to an append-only revision history.
//!
//! Layout (under the configured workspace root, default the OS app-data dir,
//! e.g. ~/Library/Application Support/com.moonspark.tat2):
//!   workspace/
//!     index.json              -> ordered pad metadata + active pad + settings
//!     pads/<id>.md            -> current content of each pad (source of truth)
//!     pads/<id>.automerge     -> Automerge CRDT doc for the pad (sync/merge state)
//!     history/<id>/<ms>.md    -> point-in-time revision snapshots
//!
//! The `.md` file is always the human-recoverable source of truth and is
//! mirrored on every change. The `.automerge` binary lives alongside it and
//! carries the conflict-free merge history used by sync (epic #3). The CRDT
//! logic itself lives in the TypeScript layer (`src/automerge/`); Rust treats
//! the `.automerge` blob as opaque bytes and only guarantees that the binary
//! and its `.md` mirror are written together, atomically and durably.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Minimum gap between automatic revision snapshots for a single pad.
const SNAPSHOT_THROTTLE_MS: u64 = 90_000; // 90s
/// Keep at most this many recent snapshots per pad (older ones are pruned).
const MAX_SNAPSHOTS_PER_PAD: usize = 200;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PadMeta {
    pub id: String,
    pub title: String,
    pub color: String,
    pub order: u32,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(rename = "fontSize", default)]
    pub font_size: Option<u32>,
    #[serde(rename = "globalShortcut", default)]
    pub global_shortcut: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Index {
    pub version: u32,
    #[serde(rename = "activePadId")]
    pub active_pad_id: Option<String>,
    pub pads: Vec<PadMeta>,
    #[serde(default)]
    pub settings: Settings,
}

/// Full workspace returned to the frontend on launch.
#[derive(Debug, Serialize, Clone)]
pub struct Workspace {
    pub index: Index,
    /// padId -> current `.md` content (the human-recoverable source of truth).
    pub contents: BTreeMap<String, String>,
    /// padId -> Automerge `.automerge` binary, when one exists on disk. A pad
    /// missing here predates #16 and is migrated by the frontend by seeding a
    /// fresh doc from its `.md` text. Serialized as a JSON byte array.
    pub docs: BTreeMap<String, Vec<u8>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The default workspace location: `<app_data_dir>/workspace`.
fn default_workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(base.join("workspace"))
}

/// The app-config file path, deliberately stored OUTSIDE the workspace so the
/// workspace root can itself be relocated (e.g. into a synced folder) without
/// the pointer to it living inside the thing being moved. See #20.
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    Ok(base.join("config.json"))
}

/// App-level configuration that lives outside the workspace.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    /// Absolute path to the workspace root. `None` => use the default location.
    #[serde(rename = "workspaceRoot", default)]
    pub workspace_root: Option<String>,
}

fn read_config(app: &AppHandle) -> AppConfig {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<AppConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize config: {e}"))?;
    atomic_write(&path, &json)
}

/// The active workspace directory: the user-configured root if set and present
/// as a directory, otherwise the default. Falling back to the default when a
/// configured root is missing (e.g. an unmounted synced drive) keeps the app
/// usable rather than failing to launch with no pads.
fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cfg = read_config(app);
    if let Some(root) = cfg.workspace_root.as_deref().filter(|s| !s.is_empty()) {
        let p = PathBuf::from(root);
        // Use the configured root if it exists as a dir, OR if its parent exists
        // (so a brand-new, not-yet-created root is still honoured on first write).
        if p.is_dir() || p.parent().map(|pp| pp.is_dir()).unwrap_or(false) {
            return Ok(p);
        }
    }
    default_workspace_dir(app)
}

fn pads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join("pads"))
}

fn history_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join("history").join(id))
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| format!("mkdir {}: {e}", p.display()))
}

/// Fsync the directory that contains `path` so a just-completed `rename` is
/// itself durable. Without this, a crash/power-loss after `fs::rename` returns
/// can still lose the rename (the directory entry was only in the page cache),
/// reverting the file to its previous contents — the #50 data-loss window.
///
/// Best-effort by design: some platforms / filesystems don't support opening a
/// directory for fsync (notably Windows, where directory handles can't be
/// flushed this way). On those we silently skip rather than failing the write —
/// the file bytes were already fsynced before the rename, so the worst case is
/// the durability window we're narrowing here, not a lost or corrupt file.
fn fsync_parent_dir(path: &Path) {
    let Some(parent) = path.parent() else { return };
    // An empty parent ("") means the current directory; normalise it so the
    // open targets a real path.
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    if let Ok(dir) = fs::File::open(parent) {
        // Ignore the result: on filesystems/platforms where dir-fsync is
        // unsupported this returns an error we deliberately tolerate.
        let _ = dir.sync_all();
    }
}

/// Atomic write: write to a sibling temp file, fsync, rename over target, then
/// fsync the parent directory so the rename itself survives power loss (#50).
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("dat")
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(data.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp->target: {e}"))?;
    fsync_parent_dir(path);
    Ok(())
}

/// Atomic binary write: same temp→fsync→rename→dir-fsync guarantee as
/// [`atomic_write`], for the opaque Automerge `.automerge` blobs.
fn atomic_write_bytes(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("dat")
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(data).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp->target: {e}"))?;
    fsync_parent_dir(path);
    Ok(())
}

fn default_index() -> Index {
    let ts = now_ms();
    let id = format!("pad-{ts}");
    Index {
        version: 1,
        active_pad_id: Some(id.clone()),
        pads: vec![PadMeta {
            id,
            title: "Sketchpad".to_string(),
            color: "amber".to_string(),
            order: 0,
            created_at: ts,
            updated_at: ts,
        }],
        settings: Settings {
            global_shortcut: Some(default_shortcut()),
            ..Default::default()
        },
    }
}

pub fn default_shortcut() -> String {
    if cfg!(target_os = "macos") {
        "Super+Shift+Space".to_string()
    } else {
        "Ctrl+Shift+Space".to_string()
    }
}

/// The user's configured global shortcut, or the platform default.
pub fn saved_shortcut(app: &AppHandle) -> String {
    read_index(app)
        .ok()
        .and_then(|i| i.settings.global_shortcut)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_shortcut)
}

/// Read the workspace index from `root`, distinguishing two cases that
/// previously collapsed into "present a fresh empty workspace" (#57 data-loss):
///
/// - Genuinely **absent** (`NotFound`) -> first run, so a fresh default index is
///   the correct, expected result.
/// - **Present but unreadable/unparseable** (permissions, a transient I/O error,
///   a truncated/corrupt write, an unmounted synced drive surfacing the dir but
///   not the file) -> return `Err`. Silently substituting an empty workspace
///   here would hide the user's real pads and, worse, the next `save_index`
///   would persist that empty index over the only copy of their data. Surfacing
///   the error keeps the real `index.json` (and every `pads/<id>.md`) untouched
///   on disk for recovery.
///
/// Path-based (no `AppHandle`) so the absent-vs-corrupt distinction is
/// unit-testable; [`read_index`] is the thin Tauri shell over it.
fn read_index_in(root: &Path) -> Result<Index, String> {
    let path = root.join("index.json");
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse index.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default_index()),
        Err(e) => Err(format!("read index.json: {e}")),
    }
}

fn read_index(app: &AppHandle) -> Result<Index, String> {
    read_index_in(&workspace_dir(app)?)
}

fn write_index(app: &AppHandle, index: &Index) -> Result<(), String> {
    let path = workspace_dir(app)?.join("index.json");
    let json = serde_json::to_string_pretty(index).map_err(|e| format!("serialize index: {e}"))?;
    atomic_write(&path, &json)
}

fn pad_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(pads_dir(app)?.join(format!("{id}.md")))
}

fn read_pad(app: &AppHandle, id: &str) -> String {
    pad_path(app, id)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Path of a pad's Automerge binary doc, alongside its `.md`.
fn doc_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(pads_dir(app)?.join(format!("{id}.automerge")))
}

/// Read a pad's Automerge binary, if one exists yet. Pads created before #16
/// (or imported from outside) have only a `.md` and return `None` here; the
/// frontend then seeds a fresh doc from the `.md` (non-destructive migration).
fn read_doc(app: &AppHandle, id: &str) -> Option<Vec<u8>> {
    doc_path(app, id).ok().and_then(|p| fs::read(p).ok())
}

/// Newest existing snapshot timestamp for a pad, if any.
fn newest_snapshot_ms(app: &AppHandle, id: &str) -> Option<u64> {
    let dir = history_dir(app, id).ok()?;
    let mut newest: Option<u64> = None;
    for entry in fs::read_dir(&dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(stem) = name.strip_suffix(".md") {
            if let Ok(ms) = stem.parse::<u64>() {
                newest = Some(newest.map_or(ms, |n| n.max(ms)));
            }
        }
    }
    newest
}

fn prune_snapshots(app: &AppHandle, id: &str) -> Result<(), String> {
    let dir = history_dir(app, id)?;
    let mut stamps: Vec<u64> = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(stem) = name.strip_suffix(".md") {
                if let Ok(ms) = stem.parse::<u64>() {
                    stamps.push(ms);
                }
            }
        }
    }
    if stamps.len() > MAX_SNAPSHOTS_PER_PAD {
        stamps.sort_unstable();
        let remove = stamps.len() - MAX_SNAPSHOTS_PER_PAD;
        for ms in stamps.into_iter().take(remove) {
            let _ = fs::remove_file(dir.join(format!("{ms}.md")));
        }
    }
    Ok(())
}

/// Write a revision snapshot if enough time has elapsed since the last one.
fn maybe_snapshot(app: &AppHandle, id: &str, content: &str) -> Result<(), String> {
    let ts = now_ms();
    let should = match newest_snapshot_ms(app, id) {
        Some(prev) => ts.saturating_sub(prev) >= SNAPSHOT_THROTTLE_MS,
        None => true,
    };
    if should && !content.is_empty() {
        let dir = history_dir(app, id)?;
        atomic_write(&dir.join(format!("{ts}.md")), content)?;
        prune_snapshots(app, id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_workspace(app: AppHandle) -> Result<Workspace, String> {
    let mut index = read_index(&app)?;

    // Ensure there is always at least one pad.
    if index.pads.is_empty() {
        index = default_index();
        write_index(&app, &index)?;
    }
    if index.active_pad_id.is_none() {
        index.active_pad_id = index.pads.first().map(|p| p.id.clone());
    }

    let mut contents = BTreeMap::new();
    let mut docs = BTreeMap::new();
    for pad in &index.pads {
        contents.insert(pad.id.clone(), read_pad(&app, &pad.id));
        if let Some(bytes) = read_doc(&app, &pad.id) {
            docs.insert(pad.id.clone(), bytes);
        }
    }
    Ok(Workspace {
        index,
        contents,
        docs,
    })
}

#[tauri::command]
pub fn save_index(app: AppHandle, index: Index) -> Result<(), String> {
    write_index(&app, &index)
}

/// Persist a pad's content. Atomic + invisible. Snapshots are throttled.
///
/// This `.md`-only path is retained for callers that don't carry an Automerge
/// doc (legacy / imports). The primary editor path is [`save_pad_doc`], which
/// writes the CRDT binary AND the `.md` mirror together.
#[tauri::command]
pub fn save_pad(app: AppHandle, id: String, content: String) -> Result<(), String> {
    atomic_write(&pad_path(&app, &id)?, &content)?;
    maybe_snapshot(&app, &id, &content)?;
    Ok(())
}

/// Persist a pad as an Automerge doc + its `.md` mirror.
///
/// `doc` is the opaque Automerge binary; `content` is the doc's text as the
/// frontend computed it. Both are written atomically (temp→fsync→rename). The
/// `.md` is written FIRST so that, even in the impossible-but-defensive case
/// where the second write fails, the human-recoverable source of truth is the
/// one guaranteed to land — never losing the user's words. The `.automerge`
/// binary is best-effort-consistent and will be reconciled from `.md` on the
/// next launch if it ever lags. Revision snapshots remain `.md`-based and
/// throttled, so the existing history feature keeps working unchanged.
#[tauri::command]
pub fn save_pad_doc(
    app: AppHandle,
    id: String,
    doc: Vec<u8>,
    content: String,
) -> Result<(), String> {
    atomic_write(&pad_path(&app, &id)?, &content)?;
    atomic_write_bytes(&doc_path(&app, &id)?, &doc)?;
    maybe_snapshot(&app, &id, &content)?;
    Ok(())
}

// ---- Trash (recoverable soft-delete) ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrashEntry {
    pub meta: PadMeta,
    #[serde(rename = "deletedAt")]
    pub deleted_at: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct RestoredPad {
    pub meta: PadMeta,
    pub content: String,
    /// The pad's Automerge binary, if it had one, so its full merge history is
    /// restored (not just the latest text). `None` for pre-#16 / `.md`-only pads.
    pub doc: Option<Vec<u8>>,
}

fn trash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join("trash"))
}

/// Synthetic metadata for a trashed pad whose `<id>.json` is missing or corrupt,
/// so its content is still listable and restorable (never silently lost).
fn recovered_meta(id: &str) -> PadMeta {
    PadMeta {
        id: id.to_string(),
        title: "Recovered sketchpad".to_string(),
        color: "amber".to_string(),
        order: 0,
        created_at: 0,
        updated_at: 0,
    }
}

/// File modification time in epoch-ms, for ordering recovered entries.
fn file_mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        ensure_dir(parent)?;
    }
    let _ = fs::remove_dir_all(to);
    let _ = fs::remove_file(to);
    fs::rename(from, to).map_err(|e| format!("move {}: {e}", from.display()))
}

/// Soft-delete a pad within an explicit workspace `root`. Moves the pad's `.md`,
/// `.automerge`, and history into `root/trash`, then writes the trash metadata.
/// Path-based (no `AppHandle`) so it is unit-testable; [`trash_pad`] is the thin
/// Tauri shell over it. Nothing is ever hard-deleted here.
fn trash_pad_in(root: &Path, meta: PadMeta) -> Result<(), String> {
    let id = meta.id.clone();
    let trash = root.join("trash");
    let pads = root.join("pads");
    move_path(
        &pads.join(format!("{id}.md")),
        &trash.join(format!("{id}.md")),
    )?;
    move_path(
        &pads.join(format!("{id}.automerge")),
        &trash.join(format!("{id}.automerge")),
    )?;
    move_path(
        &root.join("history").join(&id),
        &trash.join("history").join(&id),
    )?;
    let entry = TrashEntry {
        meta,
        deleted_at: now_ms(),
    };
    let json = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    atomic_write(&trash.join(format!("{id}.json")), &json)
}

/// Soft-delete: move the pad's content + history into the trash, keeping meta so
/// it can be fully restored. Nothing is ever hard-deleted here.
#[tauri::command]
pub fn trash_pad(app: AppHandle, meta: PadMeta) -> Result<(), String> {
    trash_pad_in(&workspace_dir(&app)?, meta)
}

#[tauri::command]
pub fn list_trash(app: AppHandle) -> Result<Vec<TrashEntry>, String> {
    let trash = trash_dir(&app)?;
    let mut entries: Vec<TrashEntry> = vec![];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(rd) = fs::read_dir(&trash) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".json") {
                if let Ok(s) = fs::read_to_string(e.path()) {
                    if let Ok(entry) = serde_json::from_str::<TrashEntry>(&s) {
                        seen.insert(entry.meta.id.clone());
                        entries.push(entry);
                    }
                }
            }
        }
    }
    // Recover orphans: a trashed `<id>.md` with no valid `<id>.json` metadata
    // (corrupt/partially-written JSON) must still be listable and restorable —
    // the trash promise is that nothing is ever silently lost.
    if let Ok(rd) = fs::read_dir(&trash) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if let Some(id) = name.strip_suffix(".md") {
                if !seen.contains(id) {
                    seen.insert(id.to_string());
                    entries.push(TrashEntry {
                        meta: recovered_meta(id),
                        deleted_at: file_mtime_ms(&e.path()).unwrap_or(0),
                    });
                }
            }
        }
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
    Ok(entries)
}

/// Restore a trashed pad within an explicit workspace `root`. Moves the pad's
/// `.md`, `.automerge`, and history back out of `root/trash` and returns its
/// meta, content, and binary (when present). Path-based (no `AppHandle`) so it
/// is unit-testable; [`restore_pad`] is the thin Tauri shell over it.
fn restore_pad_in(root: &Path, id: &str) -> Result<RestoredPad, String> {
    let pads = root.join("pads");
    let live_md = pads.join(format!("{id}.md"));
    // Never overwrite a live pad of the same id.
    if live_md.exists() {
        return Err(format!("a pad with id {id} already exists"));
    }
    let trash = root.join("trash");
    let md_src = trash.join(format!("{id}.md"));
    if !md_src.exists() {
        return Err(format!("nothing to restore for {id}"));
    }
    // Tolerate missing/corrupt metadata: recover with synthetic meta rather than
    // refusing to restore (which would strand the content in the trash forever).
    let meta = fs::read_to_string(trash.join(format!("{id}.json")))
        .ok()
        .and_then(|s| serde_json::from_str::<TrashEntry>(&s).ok())
        .map(|entry| entry.meta)
        .unwrap_or_else(|| recovered_meta(id));
    move_path(&md_src, &live_md)?;
    move_path(
        &trash.join(format!("{id}.automerge")),
        &pads.join(format!("{id}.automerge")),
    )?;
    move_path(
        &trash.join("history").join(id),
        &root.join("history").join(id),
    )?;
    let _ = fs::remove_file(trash.join(format!("{id}.json")));
    let content = fs::read_to_string(&live_md).unwrap_or_default();
    let doc = fs::read(pads.join(format!("{id}.automerge"))).ok();
    Ok(RestoredPad { meta, content, doc })
}

/// Move a trashed pad's files back and return its meta + content.
#[tauri::command]
pub fn restore_pad(app: AppHandle, id: String) -> Result<RestoredPad, String> {
    restore_pad_in(&workspace_dir(&app)?, &id)
}

/// Permanently delete a trashed pad.
#[tauri::command]
pub fn delete_trash(app: AppHandle, id: String) -> Result<(), String> {
    let trash = trash_dir(&app)?;
    let _ = fs::remove_file(trash.join(format!("{id}.md")));
    let _ = fs::remove_file(trash.join(format!("{id}.automerge")));
    let _ = fs::remove_file(trash.join(format!("{id}.json")));
    let _ = fs::remove_dir_all(trash.join("history").join(&id));
    Ok(())
}

/// Timestamps (ms) of every saved revision for a pad, oldest first.
#[tauri::command]
pub fn list_revisions(app: AppHandle, id: String) -> Result<Vec<u64>, String> {
    let dir = history_dir(&app, &id)?;
    let mut stamps: Vec<u64> = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(stem) = name.strip_suffix(".md") {
                if let Ok(ms) = stem.parse::<u64>() {
                    stamps.push(ms);
                }
            }
        }
    }
    stamps.sort_unstable();
    Ok(stamps)
}

#[tauri::command]
pub fn read_revision(app: AppHandle, id: String, ts: u64) -> Result<String, String> {
    let path = history_dir(&app, &id)?.join(format!("{ts}.md"));
    fs::read_to_string(&path).map_err(|e| format!("read revision: {e}"))
}

/// Path-based core of [`export_pad`] so the no-clobber-on-read-error guarantee
/// (#56) is unit-testable. `src` is the pad's `.md`; `dest` is where to export.
/// The source read is fallible and propagated: if the pad's `.md` can't be read
/// (missing/permissions/I/O error) we must NOT fall back to empty and overwrite
/// the user's chosen destination with a blank file. On a read error the
/// destination is left exactly as it was — an existing file the user picked is
/// never clobbered with nothing.
fn export_pad_from(src: &Path, dest: &Path) -> Result<(), String> {
    let content =
        fs::read_to_string(src).map_err(|e| format!("read pad {}: {e}", src.display()))?;
    atomic_write(dest, &content)
}

/// Write a pad's current content to an arbitrary destination path (export).
#[tauri::command]
pub fn export_pad(app: AppHandle, id: String, dest: String) -> Result<(), String> {
    export_pad_from(&pad_path(&app, &id)?, Path::new(&dest))
}

/// Read an external file's text (import). Returns its contents.
#[tauri::command]
pub fn import_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Force a snapshot now (used before destructive actions like restoring).
#[tauri::command]
pub fn force_snapshot(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let ts = now_ms();
    let dir = history_dir(&app, &id)?;
    atomic_write(&dir.join(format!("{ts}.md")), &content)?;
    prune_snapshots(&app, &id)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Synced-folder stop-gap backend (#20)
//
// Lets the user relocate the entire workspace into a folder that some external
// tool (iCloud Drive / Dropbox / Syncthing) keeps in sync across their devices.
// Pad writes are atomic, and #16 adds the per-pad Automerge CRDT model that the
// eventual on-launch reconcile of conflict copies will build on. That reconcile
// is NOT wired in this PR: `hydrate` loads only the single `.automerge` per pad
// and `PadDocStore::merge` has no production caller yet, so two devices editing
// the SAME pad on a synced folder can still clobber at the file level — the
// sync tool may write a conflict copy and the losing device's unsynced edits are
// lost until the merge-on-launch step lands in a later issue. Treat the CRDT
// here as infrastructure for that follow-up, not a live conflict resolver.
// ---------------------------------------------------------------------------

/// Where the workspace currently lives, and whether it's the default location.
#[derive(Debug, Serialize, Clone)]
pub struct WorkspaceLocation {
    pub path: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "defaultPath")]
    pub default_path: String,
}

#[tauri::command]
pub fn get_workspace_location(app: AppHandle) -> Result<WorkspaceLocation, String> {
    let active = workspace_dir(&app)?;
    let default = default_workspace_dir(&app)?;
    Ok(WorkspaceLocation {
        path: active.to_string_lossy().to_string(),
        is_default: active == default,
        default_path: default.to_string_lossy().to_string(),
    })
}

/// Recursively copy a directory tree. Files are copied with their bytes; this
/// is intentionally a copy (not a move) so the source survives until the caller
/// has confirmed the destination is complete — never losing data mid-relocate.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    ensure_dir(to)?;
    for entry in fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if ft.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            if let Some(parent) = dst.parent() {
                ensure_dir(parent)?;
            }
            fs::copy(&src, &dst)
                .map(|_| ())
                .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))?;
        }
    }
    Ok(())
}

/// Resolve a path to an absolute, symlink-free form even when it does not exist
/// yet: canonicalize the deepest ancestor that *does* exist, then re-append the
/// not-yet-created trailing components. This collapses `..`, `.`, and symlinks so
/// the nested-root check below cannot be defeated by an indirect path that
/// actually points inside (or above) the current workspace.
fn resolve_existing(path: &Path) -> PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    let mut ancestor = path;
    let mut trailing: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        match ancestor.parent() {
            Some(parent) => {
                if let Some(name) = ancestor.file_name() {
                    trailing.push(name);
                }
                if let Ok(c) = parent.canonicalize() {
                    let mut out = c;
                    for name in trailing.iter().rev() {
                        out.push(name);
                    }
                    return out;
                }
                ancestor = parent;
            }
            // Reached the filesystem root with nothing canonicalizable; fall back
            // to the path as given (already absolute or relative as supplied).
            None => return path.to_path_buf(),
        }
    }
}

/// Whether `a` is the same path as `b` or a (proper or improper) ancestor of it.
/// Comparison is component-wise on already-resolved paths, so it is not fooled by
/// a shared textual prefix that isn't a real path boundary (e.g. `…/ws` vs
/// `…/ws-backup`).
fn is_ancestor_or_equal(a: &Path, b: &Path) -> bool {
    b.starts_with(a)
}

/// Reject a relocation whose destination is the same as, an ancestor of, or a
/// descendant of the current workspace. Any of these makes the copy→cleanup flow
/// destroy the just-copied data (the cleanup `remove_dir_all` would delete the
/// destination along with the source, or the copy would recurse into the growing
/// destination). Both paths are resolved first so symlinks / `..` can't sneak a
/// nested path past the check.
fn reject_nested_relocation(current: &Path, dest: &Path) -> Result<(), String> {
    let rc = resolve_existing(current);
    let rd = resolve_existing(dest);
    if is_ancestor_or_equal(&rc, &rd) || is_ancestor_or_equal(&rd, &rc) {
        return Err(format!(
            "{} overlaps the current workspace at {}; choose a separate folder that is neither inside nor a parent of it",
            dest.display(),
            current.display()
        ));
    }
    Ok(())
}

/// Core of [`set_workspace_root`], expressed purely in terms of paths so it is
/// unit-testable without a Tauri `AppHandle`. Performs the no-data-loss
/// copy→cleanup. Does NOT touch the persisted config — the caller commits the
/// new root only after this returns Ok, keeping the operation all-or-nothing
/// from the user's perspective.
///
/// Safety / no-data-loss contract:
///   0. Refuse if `dest` overlaps `current` (same / ancestor / descendant): such
///      a move would delete the copied data during cleanup. (fix: nested root)
///   1. Refuse if `dest` already contains a workspace (`index.json`), so we never
///      silently merge into or overwrite someone else's data.
///   2. COPY the current workspace into `dest` first (source untouched).
///   3. Caller persists the new root only after this returns Ok.
///   4. Best-effort remove the old copy. If that fails the data still lives at
///      the new (now-active) root, so nothing is lost — only a stale duplicate
///      is left behind, which is safe.
fn relocate_workspace(current: &Path, dest: &Path) -> Result<(), String> {
    // (0) Overlap guard — must run BEFORE any copy/cleanup.
    reject_nested_relocation(current, dest)?;

    // (1) Guard against clobbering existing data at the destination.
    if dest.join("index.json").exists() {
        return Err(format!(
            "{} already contains a Tat2 workspace; open it instead of moving into it",
            dest.display()
        ));
    }

    // (2) Copy the current workspace into the destination (source preserved).
    if current.exists() {
        copy_tree(current, dest)
            .map_err(|e| format!("could not copy workspace to {}: {e}", dest.display()))?;
    } else {
        ensure_dir(dest)?;
    }

    // (4) Best-effort cleanup of the old location (data already safe at dest).
    // `current != dest` is guaranteed by the overlap guard, so this never
    // removes the destination.
    if current.exists() {
        let _ = fs::remove_dir_all(current);
    }
    Ok(())
}

/// Move the workspace to `new_root` and persist the new location.
///
/// See [`relocate_workspace`] for the no-data-loss contract. The config is
/// committed only after the copy fully succeeds, so a failure before that leaves
/// the old workspace active and unchanged.
#[tauri::command]
pub fn set_workspace_root(app: AppHandle, new_root: String) -> Result<WorkspaceLocation, String> {
    let new_root = new_root.trim();
    if new_root.is_empty() {
        return Err("workspace path is empty".into());
    }
    let dest = PathBuf::from(new_root);
    let current = workspace_dir(&app)?;

    // No-op if it's already the active root (resolve both so symlinked/`..`
    // spellings of the same dir are also treated as a no-op rather than an
    // overlap error).
    if resolve_existing(&dest) == resolve_existing(&current) {
        return get_workspace_location(app);
    }

    // Perform the guarded copy→cleanup. Nothing is persisted yet.
    relocate_workspace(&current, &dest)?;

    // Commit the relocation by persisting the new root (only reached on success).
    let cfg = AppConfig {
        workspace_root: Some(dest.to_string_lossy().to_string()),
    };
    write_config(&app, &cfg)?;

    get_workspace_location(app)
}

/// Reset the workspace location back to the default (does not move data; pairs
/// with a follow-up `set_workspace_root` if the user wants to relocate again).
#[tauri::command]
pub fn clear_workspace_root(app: AppHandle) -> Result<WorkspaceLocation, String> {
    write_config(&app, &AppConfig::default())?;
    get_workspace_location(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// A unique, auto-cleaned temp directory for a single test.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let base = env::temp_dir().join(format!(
                "tat2-test-{tag}-{}-{}",
                std::process::id(),
                now_ms()
            ));
            fs::create_dir_all(&base).unwrap();
            TmpDir(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn atomic_write_roundtrips_text_and_leaves_no_tempfile() {
        let tmp = TmpDir::new("atomic-text");
        let target = tmp.path().join("nested").join("pad.md");
        atomic_write(&target, "hello\nworld").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello\nworld");
        // No leftover *.tmp sibling.
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file should be renamed away");
    }

    #[test]
    fn atomic_write_bytes_roundtrips_binary() {
        let tmp = TmpDir::new("atomic-bin");
        let target = tmp.path().join("pad.automerge");
        let data: Vec<u8> = (0u16..512).map(|n| (n % 256) as u8).collect();
        atomic_write_bytes(&target, &data).unwrap();
        assert_eq!(fs::read(&target).unwrap(), data);
    }

    #[test]
    fn atomic_write_overwrites_existing_without_corruption() {
        let tmp = TmpDir::new("atomic-overwrite");
        let target = tmp.path().join("pad.md");
        atomic_write(&target, "first").unwrap();
        atomic_write(&target, "second-longer").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second-longer");
    }

    #[test]
    fn copy_tree_preserves_files_and_nesting() {
        let tmp = TmpDir::new("copytree");
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        atomic_write(&src.join("index.json"), "{}").unwrap();
        atomic_write(&src.join("pads").join("a.md"), "alpha").unwrap();
        atomic_write_bytes(&src.join("pads").join("a.automerge"), &[1, 2, 3]).unwrap();
        atomic_write(&src.join("history").join("a").join("1.md"), "rev").unwrap();

        copy_tree(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("index.json")).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(dst.join("pads").join("a.md")).unwrap(),
            "alpha"
        );
        assert_eq!(
            fs::read(dst.join("pads").join("a.automerge")).unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(
            fs::read_to_string(dst.join("history").join("a").join("1.md")).unwrap(),
            "rev"
        );
        // Source must remain intact — copy, never move.
        assert!(src.join("index.json").exists());
    }

    #[test]
    fn app_config_serde_uses_camelcase_and_tolerates_empty() {
        let cfg = AppConfig {
            workspace_root: Some("/tmp/ws".into()),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"workspaceRoot\""));
        // Missing field deserializes to the default (None), never an error.
        let back: AppConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(back.workspace_root, None);
    }

    // --- set_workspace_root / relocate_workspace (no-data-loss) -------------

    /// Seed a minimal but complete workspace at `root` so a relocate has real
    /// `.md` + `.automerge` + history + index to move.
    fn seed_workspace(root: &Path) {
        atomic_write(&root.join("index.json"), "{\"v\":1}").unwrap();
        atomic_write(&root.join("pads").join("a.md"), "alpha").unwrap();
        atomic_write_bytes(&root.join("pads").join("a.automerge"), &[9, 8, 7]).unwrap();
        atomic_write(&root.join("history").join("a").join("1.md"), "old").unwrap();
    }

    #[test]
    fn relocate_rejects_descendant_destination() {
        // current=…/workspace, dest=…/workspace/sync — the dangerous nested case
        // that previously copied into a growing dir then deleted the copy.
        let tmp = TmpDir::new("relocate-nested");
        let current = tmp.path().join("workspace");
        seed_workspace(&current);
        let dest = current.join("sync");

        let err = relocate_workspace(&current, &dest).unwrap_err();
        assert!(err.contains("overlaps"), "got: {err}");
        // Source is completely untouched — no data loss, no partial copy.
        assert_eq!(
            fs::read_to_string(current.join("pads").join("a.md")).unwrap(),
            "alpha"
        );
        assert!(
            !dest.exists(),
            "must not have started copying into the nest"
        );
    }

    #[test]
    fn relocate_rejects_ancestor_destination() {
        // current=…/parent/workspace, dest=…/parent — moving "up" so the cleanup
        // would delete the parent containing the freshly-copied data.
        let tmp = TmpDir::new("relocate-ancestor");
        let parent = tmp.path().join("parent");
        let current = parent.join("workspace");
        seed_workspace(&current);

        let err = relocate_workspace(&current, &parent).unwrap_err();
        assert!(err.contains("overlaps"), "got: {err}");
        assert_eq!(
            fs::read_to_string(current.join("pads").join("a.md")).unwrap(),
            "alpha"
        );
    }

    #[test]
    fn relocate_rejects_symlinked_descendant() {
        // A symlink that points back inside the current workspace must not defeat
        // the overlap guard (paths are resolved before comparison).
        let tmp = TmpDir::new("relocate-symlink");
        let current = tmp.path().join("workspace");
        seed_workspace(&current);
        // dest = …/link/sub, where `link` -> current. resolve_existing must see
        // dest is inside current and reject.
        let link = tmp.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&current, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&current, &link).unwrap();
        let dest = link.join("sub");

        let err = relocate_workspace(&current, &dest).unwrap_err();
        assert!(err.contains("overlaps"), "got: {err}");
        assert_eq!(
            fs::read_to_string(current.join("pads").join("a.md")).unwrap(),
            "alpha"
        );
    }

    #[test]
    fn relocate_to_sibling_moves_data_without_loss() {
        // A normal, separate destination succeeds: all files arrive at dest and
        // the old location is cleaned up.
        let tmp = TmpDir::new("relocate-sibling");
        let current = tmp.path().join("workspace");
        let dest = tmp.path().join("synced-workspace");
        seed_workspace(&current);

        relocate_workspace(&current, &dest).unwrap();

        // Every file landed at the destination, byte-for-byte.
        assert_eq!(
            fs::read_to_string(dest.join("index.json")).unwrap(),
            "{\"v\":1}"
        );
        assert_eq!(
            fs::read_to_string(dest.join("pads").join("a.md")).unwrap(),
            "alpha"
        );
        assert_eq!(
            fs::read(dest.join("pads").join("a.automerge")).unwrap(),
            vec![9, 8, 7]
        );
        assert_eq!(
            fs::read_to_string(dest.join("history").join("a").join("1.md")).unwrap(),
            "old"
        );
        // Old location removed (best-effort cleanup succeeded here).
        assert!(!current.exists(), "old workspace should be cleaned up");
    }

    #[test]
    fn relocate_into_existing_workspace_is_refused() {
        // Destination already holds a workspace (index.json) -> refuse, never
        // merge/overwrite someone else's data.
        let tmp = TmpDir::new("relocate-existing");
        let current = tmp.path().join("workspace");
        let dest = tmp.path().join("other");
        seed_workspace(&current);
        atomic_write(&dest.join("index.json"), "{\"theirs\":true}").unwrap();

        let err = relocate_workspace(&current, &dest).unwrap_err();
        assert!(err.contains("already contains"), "got: {err}");
        // Their index is untouched and ours still exists.
        assert_eq!(
            fs::read_to_string(dest.join("index.json")).unwrap(),
            "{\"theirs\":true}"
        );
        assert!(current.join("index.json").exists());
    }

    // --- trash / restore with an .automerge present ------------------------

    #[test]
    fn trash_then_restore_roundtrips_md_and_automerge() {
        let tmp = TmpDir::new("trash-restore");
        let root = tmp.path();
        let pads = root.join("pads");
        atomic_write(&pads.join("p.md"), "hello world").unwrap();
        let doc_bytes: Vec<u8> = vec![0, 1, 2, 3, 250, 255];
        atomic_write_bytes(&pads.join("p.automerge"), &doc_bytes).unwrap();
        atomic_write(&root.join("history").join("p").join("100.md"), "v1").unwrap();

        let meta = PadMeta {
            id: "p".into(),
            title: "Pad".into(),
            color: "amber".into(),
            order: 0,
            created_at: 1,
            updated_at: 2,
        };

        // Trash: live files move into trash/, including the .automerge.
        trash_pad_in(root, meta.clone()).unwrap();
        assert!(!pads.join("p.md").exists());
        assert!(!pads.join("p.automerge").exists());
        assert!(root.join("trash").join("p.md").exists());
        assert!(root.join("trash").join("p.automerge").exists());
        assert!(root
            .join("trash")
            .join("history")
            .join("p")
            .join("100.md")
            .exists());

        // Restore: everything comes back, and the .automerge bytes are returned
        // exactly so the CRDT history is preserved (not just the latest text).
        let restored = restore_pad_in(root, "p").unwrap();
        assert_eq!(restored.content, "hello world");
        assert_eq!(restored.meta.id, "p");
        assert_eq!(restored.meta.title, "Pad");
        assert_eq!(restored.doc, Some(doc_bytes));
        assert!(pads.join("p.md").exists());
        assert!(pads.join("p.automerge").exists());
        assert_eq!(
            fs::read_to_string(root.join("history").join("p").join("100.md")).unwrap(),
            "v1"
        );
        // Trash is emptied of this pad's artifacts.
        assert!(!root.join("trash").join("p.md").exists());
        assert!(!root.join("trash").join("p.automerge").exists());
        assert!(!root.join("trash").join("p.json").exists());
    }

    #[test]
    fn restore_refuses_to_clobber_a_live_pad() {
        let tmp = TmpDir::new("restore-clobber");
        let root = tmp.path();
        // A trashed copy exists...
        atomic_write(&root.join("trash").join("p.md"), "trashed").unwrap();
        // ...but a live pad with the same id is present.
        atomic_write(&root.join("pads").join("p.md"), "live").unwrap();

        let err = restore_pad_in(root, "p").unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        // The live pad is untouched.
        assert_eq!(
            fs::read_to_string(root.join("pads").join("p.md")).unwrap(),
            "live"
        );
    }

    // --- #50: parent-dir fsync after rename --------------------------------

    #[test]
    fn atomic_write_fsyncs_parent_and_lands_file() {
        // We can't observe an fsync directly in a unit test, but we CAN assert
        // the write path (which now fsyncs the parent dir after rename) succeeds
        // and lands the file with no leftover temp, on a freshly-created nested
        // directory whose parent had to be created — i.e. the dir handle that
        // fsync_parent_dir opens is valid and the extra durability step never
        // breaks or fails the write (#50).
        let tmp = TmpDir::new("fsync-parent");
        let target = tmp.path().join("deep").join("nest").join("pad.md");
        atomic_write(&target, "durable").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "durable");
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file should be renamed away");
    }

    #[test]
    fn fsync_parent_dir_tolerates_missing_and_root_paths() {
        // Must never panic / fail: a path whose parent doesn't exist, and a bare
        // filename (empty parent -> current dir). Both are tolerated silently.
        fsync_parent_dir(Path::new("/this/does/not/exist/at/all/file.md"));
        fsync_parent_dir(Path::new("bare-name.md"));
    }

    // --- #56: export_pad must not clobber the destination on read error ------

    #[test]
    fn export_writes_pad_content_to_destination() {
        let tmp = TmpDir::new("export-ok");
        let src = tmp.path().join("pads").join("p.md");
        atomic_write(&src, "exported words").unwrap();
        let dest = tmp.path().join("out").join("export.md");

        export_pad_from(&src, &dest).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "exported words");
    }

    #[test]
    fn export_leaves_existing_destination_untouched_when_source_unreadable() {
        // The #56 bug: an unreadable source used to read as "" and overwrite the
        // chosen destination with an empty file. Now the read error propagates
        // and the destination the user picked keeps its prior contents.
        let tmp = TmpDir::new("export-noclobber");
        let missing_src = tmp.path().join("pads").join("missing.md");
        let dest = tmp.path().join("important.md");
        atomic_write(&dest, "DO NOT LOSE THIS").unwrap();

        let err = export_pad_from(&missing_src, &dest).unwrap_err();
        assert!(err.contains("read pad"), "got: {err}");
        // Destination is byte-for-byte unchanged — never overwritten with empty.
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            "DO NOT LOSE THIS",
            "export must not clobber the destination when the source is unreadable"
        );
    }

    #[test]
    fn export_does_not_create_destination_when_source_unreadable() {
        // When there's no pre-existing destination, a failed source read must not
        // leave behind a stray empty file either.
        let tmp = TmpDir::new("export-nocreate");
        let missing_src = tmp.path().join("pads").join("missing.md");
        let dest = tmp.path().join("new-export.md");

        assert!(export_pad_from(&missing_src, &dest).is_err());
        assert!(
            !dest.exists(),
            "no destination file should be created on a source read error"
        );
    }

    // --- #57: read_index distinguishes absent (fresh) from corrupt (error) ---

    #[test]
    fn read_index_returns_fresh_default_on_first_run() {
        // No index.json present at all -> genuinely first run -> a fresh default
        // workspace (one starter pad) is the correct, expected result.
        let tmp = TmpDir::new("index-firstrun");
        let idx = read_index_in(tmp.path()).unwrap();
        assert_eq!(idx.pads.len(), 1, "fresh workspace seeds one starter pad");
        assert!(idx.active_pad_id.is_some());
    }

    #[test]
    fn read_index_errors_on_corrupt_existing_index() {
        // The #57 bug: ANY read/parse failure used to silently return a fresh
        // EMPTY workspace, hiding the user's real pads and risking a later
        // save_index overwriting their only copy. A present-but-unparseable
        // index.json must now surface an error instead.
        let tmp = TmpDir::new("index-corrupt");
        atomic_write(&tmp.path().join("index.json"), "{ this is not valid json").unwrap();

        let err = read_index_in(tmp.path()).unwrap_err();
        assert!(err.contains("parse index.json"), "got: {err}");
        // The real (corrupt-but-present) index file is left on disk untouched for
        // recovery — never silently replaced by an empty workspace.
        assert!(tmp.path().join("index.json").exists());
    }

    #[test]
    fn read_index_roundtrips_a_real_index() {
        // A well-formed existing index is returned as-is (not replaced by fresh).
        let tmp = TmpDir::new("index-real");
        let index = Index {
            version: 1,
            active_pad_id: Some("pad-x".into()),
            pads: vec![
                PadMeta {
                    id: "pad-x".into(),
                    title: "First".into(),
                    color: "amber".into(),
                    order: 0,
                    created_at: 1,
                    updated_at: 2,
                },
                PadMeta {
                    id: "pad-y".into(),
                    title: "Second".into(),
                    color: "blue".into(),
                    order: 1,
                    created_at: 3,
                    updated_at: 4,
                },
            ],
            settings: Settings::default(),
        };
        let json = serde_json::to_string_pretty(&index).unwrap();
        atomic_write(&tmp.path().join("index.json"), &json).unwrap();

        let back = read_index_in(tmp.path()).unwrap();
        assert_eq!(back.pads.len(), 2);
        assert_eq!(back.active_pad_id.as_deref(), Some("pad-x"));
        assert_eq!(back.pads[1].id, "pad-y");
    }
}
