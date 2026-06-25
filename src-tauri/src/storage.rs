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

/// Atomic write: write to a sibling temp file, fsync, then rename over target.
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
    Ok(())
}

/// Atomic binary write: same temp→fsync→rename guarantee as [`atomic_write`],
/// for the opaque Automerge `.automerge` blobs.
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

fn read_index(app: &AppHandle) -> Result<Index, String> {
    let path = workspace_dir(app)?.join("index.json");
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse index.json: {e}")),
        Err(_) => Ok(default_index()),
    }
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

/// Soft-delete: move the pad's content + history into the trash, keeping meta so
/// it can be fully restored. Nothing is ever hard-deleted here.
#[tauri::command]
pub fn trash_pad(app: AppHandle, meta: PadMeta) -> Result<(), String> {
    let id = meta.id.clone();
    let trash = trash_dir(&app)?;
    move_path(&pad_path(&app, &id)?, &trash.join(format!("{id}.md")))?;
    move_path(
        &doc_path(&app, &id)?,
        &trash.join(format!("{id}.automerge")),
    )?;
    move_path(&history_dir(&app, &id)?, &trash.join("history").join(&id))?;
    let entry = TrashEntry {
        meta,
        deleted_at: now_ms(),
    };
    let json = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    atomic_write(&trash.join(format!("{id}.json")), &json)
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

/// Move a trashed pad's files back and return its meta + content.
#[tauri::command]
pub fn restore_pad(app: AppHandle, id: String) -> Result<RestoredPad, String> {
    // Never overwrite a live pad of the same id.
    if pad_path(&app, &id)?.exists() {
        return Err(format!("a pad with id {id} already exists"));
    }
    let trash = trash_dir(&app)?;
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
        .unwrap_or_else(|| recovered_meta(&id));
    move_path(&md_src, &pad_path(&app, &id)?)?;
    move_path(
        &trash.join(format!("{id}.automerge")),
        &doc_path(&app, &id)?,
    )?;
    move_path(&trash.join("history").join(&id), &history_dir(&app, &id)?)?;
    let _ = fs::remove_file(trash.join(format!("{id}.json")));
    let content = read_pad(&app, &id);
    let doc = read_doc(&app, &id);
    Ok(RestoredPad { meta, content, doc })
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

/// Write a pad's current content to an arbitrary destination path (export).
#[tauri::command]
pub fn export_pad(app: AppHandle, id: String, dest: String) -> Result<(), String> {
    let content = read_pad(&app, &id);
    atomic_write(Path::new(&dest), &content)
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
// Because pad writes are atomic AND — since #16 — Automerge-CRDT-merged, two
// devices editing the same synced folder reconcile instead of clobbering: on
// each launch the frontend merges any `.automerge` it finds on disk into its
// in-memory doc, so concurrent edits converge. (Pre-#16 the documented caveat
// was that the sync tool could produce file-level conflict copies; that is now
// resolved at the CRDT layer.)
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

/// Move the workspace to `new_root` and persist the new location.
///
/// Safety / no-data-loss contract:
///   1. Refuse if `new_root` already contains a workspace (`index.json`), so we
///      never silently merge into or overwrite someone else's data.
///   2. COPY the current workspace into `new_root` first (source untouched).
///   3. Only after the copy fully succeeds, point the config at the new root.
///   4. Best-effort remove the old copy. If that fails the data still lives at
///      the new (now-active) root, so nothing is lost — only a stale duplicate
///      is left behind, which is safe.
///
/// If any step before (3) fails, the old workspace remains the active one and
/// no config change is made: the operation is all-or-nothing from the user's
/// perspective.
#[tauri::command]
pub fn set_workspace_root(app: AppHandle, new_root: String) -> Result<WorkspaceLocation, String> {
    let new_root = new_root.trim();
    if new_root.is_empty() {
        return Err("workspace path is empty".into());
    }
    let dest = PathBuf::from(new_root);
    let current = workspace_dir(&app)?;

    // No-op if it's already the active root.
    if dest == current {
        return get_workspace_location(app);
    }

    // (1) Guard against clobbering existing data at the destination.
    if dest.join("index.json").exists() {
        return Err(format!(
            "{} already contains a Tat2 workspace; open it instead of moving into it",
            dest.display()
        ));
    }

    // (2) Copy the current workspace into the destination (source preserved).
    if current.exists() {
        copy_tree(&current, &dest)
            .map_err(|e| format!("could not copy workspace to {}: {e}", dest.display()))?;
    } else {
        ensure_dir(&dest)?;
    }

    // (3) Commit the relocation by persisting the new root.
    let cfg = AppConfig {
        workspace_root: Some(dest.to_string_lossy().to_string()),
    };
    write_config(&app, &cfg)?;

    // (4) Best-effort cleanup of the old location (data already safe at dest).
    if current.exists() && current != dest {
        let _ = fs::remove_dir_all(&current);
    }

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
}
