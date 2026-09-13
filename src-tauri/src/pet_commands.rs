use crate::{error::AppResult, pet_packs::*, state::AppState};
use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

pub struct PetRuntime {
    store: Mutex<Option<PetStore>>,
    name: RwLock<String>,
}
impl Default for PetRuntime {
    fn default() -> Self {
        Self {
            store: Mutex::new(None),
            name: RwLock::new("圆圆".into()),
        }
    }
}
pub fn current_name(app: &AppHandle) -> String {
    app.try_state::<PetRuntime>()
        .map(|s| s.name.read().clone())
        .unwrap_or_else(|| "圆圆".into())
}
fn with_store<T>(
    app: &AppHandle,
    action: impl FnOnce(&mut PetStore) -> AppResult<T>,
) -> AppResult<T> {
    let runtime = app.state::<PetRuntime>();
    let mut guard = runtime.store.lock();
    if guard.is_none() {
        #[cfg(feature = "runtime-qa")]
        let root = crate::runtime_qa::app_data_directory(&app.config().identifier)?;
        #[cfg(not(feature = "runtime-qa"))]
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| crate::error::AppError::Window(e.to_string()))?;
        *guard = Some(PetStore::open(root.join("pet-packs"))?);
    }
    action(guard.as_mut().unwrap())
}
fn profile(app: &AppHandle) -> AppResult<PetProfile> {
    let profile = app
        .state::<AppState>()
        .repository
        .lock()
        .get_settings()?
        .pet_profile;
    profile.validate()?;
    Ok(profile)
}
fn publish(app: &AppHandle, store: &PetStore) -> AppResult<ProfileSnapshot> {
    let snapshot = store.snapshot(&profile(app)?);
    *app.state::<PetRuntime>().name.write() = snapshot.nickname.clone();
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_title(&snapshot.nickname);
    }
    crate::tray::refresh_pet_name(app, &snapshot.nickname);
    let _ = app.emit("pet-profile-updated", &snapshot);
    let _ = app.emit("pet-catalog-updated", store.revision);
    Ok(snapshot)
}
async fn background<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| invalid("宠物操作未完成，请重试。"))?
}
pub fn refresh_after_restore(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = with_store(&app, |store| {
            store.bump();
            publish(&app, store)
        });
    });
}
/// Keep restore and nickname/selection mutations in the same revision order.
/// Do not initialize the asset store here: unavailable pet files must not block data restore.
pub fn during_backup_restore<T>(
    app: &AppHandle,
    restore: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let runtime = app.state::<PetRuntime>();
    let mut guard = runtime.store.lock();
    let result = restore();
    // Even a late restore-side failure can have replaced the database already.
    if let Some(store) = guard.as_mut() {
        store.bump();
        let _ = publish(app, store);
    }
    result
}
#[tauri::command]
pub async fn get_pet_profile(app: AppHandle) -> AppResult<ProfileSnapshot> {
    background(move || {
        with_store(&app, |store| {
            let snapshot = store.snapshot(&profile(&app)?);
            *app.state::<PetRuntime>().name.write() = snapshot.nickname.clone();
            Ok(snapshot)
        })
    })
    .await
}
#[tauri::command]
pub async fn get_pet_catalog(app: AppHandle) -> AppResult<Vec<PackSummary>> {
    background(move || with_store(&app, |store| Ok(store.catalog()))).await
}
#[tauri::command]
pub async fn preview_pet_pack_import(app: AppHandle) -> AppResult<Option<ImportPreview>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut picker = app
        .dialog()
        .file()
        .set_title("选择本地宠物包")
        .add_filter("宠物包", &["yuanyuan-pet"]);
    if let Some(panel) = app.get_webview_window("panel").as_ref() {
        picker = picker.set_parent(panel);
    }
    let dialog_scope = crate::windows::PanelDialogScope::enter(&app)?;
    picker.pick_file(move |file| {
        let _ = sender.send(file);
    });
    let selected = receiver.await.map_err(|_| invalid("文件选择未完成。"))?;
    drop(dialog_scope);
    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| invalid("请选择本地宠物包。"))?;
    background(move || with_store(&app, |store| store.preview(&path).map(Some))).await
}
#[tauri::command]
pub async fn cancel_pet_pack_import(app: AppHandle, token: String) -> AppResult<()> {
    background(move || with_store(&app, |store| store.cancel(&token))).await
}
#[tauri::command]
pub async fn commit_pet_pack_import(app: AppHandle, token: String) -> AppResult<PackSummary> {
    background(move || {
        with_store(&app, |store| {
            let result = store.commit(&token)?;
            publish(&app, store)?;
            Ok(result)
        })
    })
    .await
}
fn mutate_profile(
    app: &AppHandle,
    store: &mut PetStore,
    revision: u64,
    change: impl FnOnce(&mut PetProfile, &mut PetStore) -> AppResult<()>,
) -> AppResult<ProfileSnapshot> {
    store.check_revision(revision)?;
    let mut profile = profile(app)?;
    let old_id = profile.selected_pack_id.clone();
    change(&mut profile, store)?;
    app.state::<AppState>()
        .repository
        .lock()
        .save_pet_profile(&profile)?;
    store.bump();
    if old_id != profile.selected_pack_id {
        crate::presentation_runtime::cancel_user_interaction(
            app,
            chrono::Utc::now().timestamp_millis(),
        )?;
    }
    publish(app, store)
}
#[tauri::command]
pub async fn activate_pet_pack(
    app: AppHandle,
    pack_id: String,
    expected_revision: u64,
) -> AppResult<ProfileSnapshot> {
    background(move || {
        with_store(&app, |store| {
            mutate_profile(&app, store, expected_revision, |profile, store| {
                store.ensure_pack(&pack_id)?;
                store.clear_failures(&pack_id);
                profile.selected_pack_id = pack_id;
                Ok(())
            })
        })
    })
    .await
}
#[tauri::command]
pub async fn set_pet_nickname(
    app: AppHandle,
    pack_id: String,
    value: Option<String>,
    expected_revision: u64,
) -> AppResult<ProfileSnapshot> {
    background(move || {
        with_store(&app, |store| {
            mutate_profile(&app, store, expected_revision, |profile, store| {
                store.ensure_known(&pack_id)?;
                match value {
                    Some(value) => {
                        profile.nicknames.insert(pack_id, nickname(&value)?);
                    }
                    None => {
                        profile.nicknames.remove(&pack_id);
                    }
                }
                Ok(())
            })
        })
    })
    .await
}
#[tauri::command]
pub async fn reset_pet_profile(
    app: AppHandle,
    expected_revision: u64,
) -> AppResult<ProfileSnapshot> {
    background(move || {
        with_store(&app, |store| {
            mutate_profile(&app, store, expected_revision, |profile, _| {
                profile.selected_pack_id = BUILTIN.into();
                profile.nicknames.remove(BUILTIN);
                Ok(())
            })
        })
    })
    .await
}
#[tauri::command]
pub async fn remove_pet_pack(
    app: AppHandle,
    pack_id: String,
    expected_revision: u64,
) -> AppResult<ProfileSnapshot> {
    background(move || {
        with_store(&app, |store| {
            store.check_revision(expected_revision)?;
            store.remove(&pack_id, &profile(&app)?, |next| {
                app.state::<AppState>()
                    .repository
                    .lock()
                    .save_pet_profile(next)
            })?;
            publish(&app, store)
        })
    })
    .await
}
#[tauri::command]
pub async fn report_pet_resource_failure(
    app: AppHandle,
    pack_id: String,
    sheet: String,
    expected_revision: u64,
) -> AppResult<ProfileSnapshot> {
    background(move || {
        with_store(&app, |store| {
            if store.revision == expected_revision {
                store.report_failure(&pack_id, &sheet)?;
            }
            publish(&app, store)
        })
    })
    .await
}
pub fn resource(app: &AppHandle, path: &str) -> AppResult<Vec<u8>> {
    let components: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if components.len() != 2 {
        return Err(invalid("未知资源地址。"));
    }
    with_store(app, |store| store.resource(components[0], components[1]))
}
