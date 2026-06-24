//! Local-first, never-fail storage for Tat2.
//!
//! Source of truth is plain Markdown on disk so a pad is always recoverable
//! with any text editor. Writes are atomic (temp file + rename) so a crash or
//! power loss can never leave a half-written / corrupt pad. Every meaningful
//! change is also appended to an append-only revision history.
//!
//! Layout (under the OS app-data dir, e.g. ~/Library/Application Support/com.moonspark.tat2):
//!   workspace/
//!     index.json            -> ordered pad metadata + active pad + settings
//!     pads/<id>.md          -> current content of each pad (source of truth)
//!     history/<id>/<ms>.md  -> point-in-time revision snapshots

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
    /// padId -> current content
    pub contents: BTreeMap<String, String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(base.join("workspace"))
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
        "Cmd+Shift+Space".to_string()
    } else {
        "Ctrl+Shift+Space".to_string()
    }
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
    for pad in &index.pads {
        contents.insert(pad.id.clone(), read_pad(&app, &pad.id));
    }
    Ok(Workspace { index, contents })
}

#[tauri::command]
pub fn save_index(app: AppHandle, index: Index) -> Result<(), String> {
    write_index(&app, &index)
}

/// Persist a pad's content. Atomic + invisible. Snapshots are throttled.
#[tauri::command]
pub fn save_pad(app: AppHandle, id: String, content: String) -> Result<(), String> {
    atomic_write(&pad_path(&app, &id)?, &content)?;
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
}

fn trash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join("trash"))
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
    if let Ok(rd) = fs::read_dir(&trash) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".json") {
                if let Ok(s) = fs::read_to_string(e.path()) {
                    if let Ok(entry) = serde_json::from_str::<TrashEntry>(&s) {
                        entries.push(entry);
                    }
                }
            }
        }
    }
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
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
    let json = fs::read_to_string(trash.join(format!("{id}.json")))
        .map_err(|e| format!("trash entry: {e}"))?;
    let entry: TrashEntry = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    move_path(&trash.join(format!("{id}.md")), &pad_path(&app, &id)?)?;
    move_path(&trash.join("history").join(&id), &history_dir(&app, &id)?)?;
    let _ = fs::remove_file(trash.join(format!("{id}.json")));
    let content = read_pad(&app, &id);
    Ok(RestoredPad {
        meta: entry.meta,
        content,
    })
}

/// Permanently delete a trashed pad.
#[tauri::command]
pub fn delete_trash(app: AppHandle, id: String) -> Result<(), String> {
    let trash = trash_dir(&app)?;
    let _ = fs::remove_file(trash.join(format!("{id}.md")));
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
