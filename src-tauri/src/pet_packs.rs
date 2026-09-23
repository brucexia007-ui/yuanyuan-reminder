//! Offline, data-only pet packages. No package path is accepted from a WebView.
#[cfg(test)]
#[path = "pet_packs_tests.rs"]
mod tests;
use crate::error::{AppError, AppResult};
use image::{ImageDecoder, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

pub const BUILTIN: &str = "builtin:yuanyuan";
const LIMIT: u64 = 64 * 1024 * 1024;
const FILES: &[&str] = &[
    "pet-pack.json",
    "LICENSE.txt",
    "fallback.png",
    "spritesheet.webp",
    "sleep-atlas.webp",
    "life-atlas.webp",
    "learning-atlas.webp",
    "scene-atlas.webp",
];
const REQUIRED: &[&str] = &[
    "pet-pack.json",
    "LICENSE.txt",
    "fallback.png",
    "spritesheet.webp",
    "sleep-atlas.webp",
    "life-atlas.webp",
];

pub fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}
pub fn valid_id(id: &str) -> bool {
    id == BUILTIN
        || (id.len() == 64
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}
pub fn nickname(value: &str) -> AppResult<String> {
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err(invalid("昵称不能含换行或控制字符。"));
    }
    let value = value.trim();
    if !(1..=24).contains(&value.chars().count()) {
        return Err(invalid("昵称需要 1–24 个字符。"));
    }
    Ok(value.to_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PetProfile {
    pub schema_version: u8,
    pub selected_pack_id: String,
    pub nicknames: BTreeMap<String, String>,
}
impl Default for PetProfile {
    fn default() -> Self {
        Self {
            schema_version: 1,
            selected_pack_id: BUILTIN.into(),
            nicknames: BTreeMap::new(),
        }
    }
}
impl PetProfile {
    pub fn validate(&self) -> AppResult<()> {
        if self.schema_version != 1
            || !valid_id(&self.selected_pack_id)
            || self.nicknames.len() > 1024
        {
            return Err(invalid("宠物配置格式不正确。"));
        }
        for (id, name) in &self.nicknames {
            if !valid_id(id) || nickname(name)? != *name {
                return Err(invalid("宠物昵称配置不正确。"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub learning: bool,
    pub scene: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    pub pack_id: String,
    pub display_name: String,
    pub builtin: bool,
    pub capabilities: Capabilities,
    pub manifest: Value,
    pub fallback_image: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub revision: u64,
    pub selected_pack_id: String,
    pub effective_pack_id: String,
    pub nickname: String,
    pub capabilities: Capabilities,
    pub manifest: Value,
    pub fallback_image: String,
    pub fallback_reason: Option<String>,
    pub static_only: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub token: String,
    pub pack: PackSummary,
    pub license: String,
    pub already_installed: bool,
}

#[derive(Clone)]
struct Pack {
    summary: PackSummary,
    directory: PathBuf,
    hashes: BTreeMap<String, String>,
}
pub struct PetStore {
    root: PathBuf,
    pub revision: u64,
    packs: BTreeMap<String, Pack>,
    pending: BTreeMap<String, Pack>,
    failures: BTreeMap<String, BTreeSet<String>>,
}

pub fn builtin_summary() -> PackSummary {
    let manifest: Value =
        serde_json::from_str(include_str!("../../public/assets/pet/pet-manifest.json"))
            .expect("bundled manifest");
    PackSummary {
        pack_id: BUILTIN.into(),
        display_name: "圆圆".into(),
        builtin: true,
        capabilities: Capabilities {
            learning: true,
            scene: true,
        },
        manifest,
        fallback_image: "/assets/pet/fallback.png".into(),
    }
}

fn plain(path: &Path, directory: bool) -> AppResult<()> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(invalid("宠物素材不能使用文件链接。"));
        }
    }
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err(invalid("宠物素材路径不正确。"));
    }
    Ok(())
}

fn validate_archive_directory(
    data: &[u8],
    start: u64,
    expected_entries: usize,
    minimum_entries: usize,
) -> AppResult<()> {
    // ZipArchive's name map silently collapses repeated central-directory names.
    // Inspect the original bounded bytes, before extracting any file, so that
    // neither duplicate members nor a forged smaller entry count can hide them.
    let mut position = usize::try_from(start).map_err(|_| invalid("宠物包目录损坏。"))?;
    let mut names = BTreeSet::new();
    while data.get(position..position.saturating_add(4)) == Some(b"PK\x01\x02") {
        let header = data
            .get(position..position.saturating_add(46))
            .ok_or_else(|| invalid("宠物包目录损坏。"))?;
        let length_at =
            |offset| usize::from(u16::from_le_bytes([header[offset], header[offset + 1]]));
        let name_length = length_at(28);
        let entry_length = 46 + name_length + length_at(30) + length_at(32);
        let entry = data
            .get(position..position.saturating_add(entry_length))
            .ok_or_else(|| invalid("宠物包目录损坏。"))?;
        let name = &entry[46..46 + name_length];
        if !FILES.iter().any(|allowed| allowed.as_bytes() == name) || !names.insert(name) {
            return Err(invalid("宠物包包含重复文件、链接或不允许的内容。"));
        }
        if names.len() > FILES.len() {
            return Err(invalid("宠物包文件数量不正确。"));
        }
        position += entry_length;
    }
    if names.len() != expected_entries || !(minimum_entries..=FILES.len()).contains(&names.len()) {
        return Err(invalid("宠物包目录文件数量不一致。"));
    }
    Ok(())
}

// One transport boundary for production import and the offline repair tool.
// A tool may inspect an incomplete but safe archive; production still requires 6..=8 entries.
fn read_archive(data: &[u8], minimum_entries: usize) -> AppResult<BTreeMap<String, Vec<u8>>> {
    if data.len() as u64 > LIMIT {
        return Err(invalid("宠物包超过 64 MiB。"));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(data))
        .map_err(|_| invalid("宠物包不是有效 ZIP 文件。"))?;
    if !(minimum_entries..=FILES.len()).contains(&archive.len()) {
        return Err(invalid("宠物包文件数量不正确。"));
    }
    validate_archive_directory(
        data,
        archive.central_directory_start(),
        archive.len(),
        minimum_entries,
    )?;
    let mut files = BTreeMap::new();
    let mut total = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| invalid("宠物包损坏或已加密。"))?;
        let name = file.name().to_owned();
        if !FILES.contains(&name.as_str())
            || files.contains_key(&name)
            || file.encrypted()
            || file
                .unix_mode()
                .is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000)
        {
            return Err(invalid("宠物包包含重复文件、链接或不允许的内容。"));
        }
        let remaining = file_limit(&name).min(LIMIT - total);
        if file.size() > remaining {
            return Err(invalid("解压大小超过限制。"));
        }
        let mut bytes = Vec::new();
        (&mut file).take(remaining + 1).read_to_end(&mut bytes)?;
        total += bytes.len() as u64;
        if bytes.len() as u64 > remaining {
            return Err(invalid("实际解压大小超过限制。"));
        }
        files.insert(name, bytes);
    }
    Ok(files)
}

#[cfg(feature = "pet-repair-tools")]
pub fn repair_tools_run(
    command: &str,
    source: &Path,
    destination: Option<&Path>,
) -> AppResult<Value> {
    match command {
        "extract" => {
            let bytes = bounded_read(source, LIMIT)?;
            let files = read_archive(&bytes, 1)?;
            let destination = destination.ok_or_else(|| invalid("缺少新的工作目录。"))?;
            // No overwrite, no partial extraction of unsafe archives, and no application store access.
            let parent = destination
                .parent()
                .ok_or_else(|| invalid("工作目录不正确。"))?;
            plain(parent, true)?;
            fs::create_dir(destination)?;
            let result = (|| {
                use std::io::Write;
                for (name, data) in &files {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination.join(name))?;
                    file.write_all(data)?;
                }
                let hashes: BTreeMap<_, _> = files
                    .iter()
                    .map(|(name, bytes)| (name.clone(), digest(bytes)))
                    .collect();
                Ok(
                    json!({"schemaVersion":1,"archiveSha256":digest(&bytes),"files":hashes,
                    "validation":repair_validation(destination)}),
                )
            })();
            if result.is_err() {
                let _ = fs::remove_dir_all(destination);
            }
            result
        }
        "validate" => Ok(repair_validation(source)),
        _ => Err(invalid("未知离线检查命令。")),
    }
}

#[cfg(feature = "pet-repair-tools")]
fn repair_validation(directory: &Path) -> Value {
    // Keep validation identical to the final native import, including real image decoding.
    match inspect(directory) {
        Ok(pack) => json!({"valid":true,"packId":pack.summary.pack_id,"errors":[]}),
        Err(error) => {
            let message = match error {
                AppError::Validation(message) => message,
                _ => "清单无法解析或文件读取失败。".to_owned(),
            };
            json!({"valid":false,"packId":null,"errors":[message]})
        }
    }
}
fn bounded_read(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    plain(path, false)?;
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(invalid("宠物文件超过大小限制。"));
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(invalid("宠物文件超过大小限制。"));
    }
    Ok(data)
}
fn file_limit(name: &str) -> u64 {
    match name {
        "pet-pack.json" => 256 * 1024,
        "LICENSE.txt" => 64 * 1024,
        _ => LIMIT,
    }
}
fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn content_id(hashes: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    for (name, value) in hashes {
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    format!("{hash:x}", hash = hash.finalize())
}
fn validate_image(name: &str, bytes: &[u8]) -> AppResult<()> {
    let height = match name {
        "spritesheet.webp" => 2288,
        "sleep-atlas.webp" => 624,
        "life-atlas.webp" => 4368,
        "learning-atlas.webp" => 832,
        "scene-atlas.webp" => 3744,
        "fallback.png" => 208,
        _ => return Ok(()),
    };
    let width = if name == "fallback.png" { 192 } else { 1536 };
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid("图片格式不正确。"))?;
    let expected_format = if name.ends_with(".png") {
        image::ImageFormat::Png
    } else {
        image::ImageFormat::WebP
    };
    if reader.format() != Some(expected_format) {
        return Err(invalid("图片内容与文件格式不一致。"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(LIMIT);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|_| invalid("图片无法解码。"))?;
    if decoder.dimensions() != (width, height) || !decoder.color_type().has_alpha() {
        return Err(invalid(format!("{name} 的尺寸或透明通道不正确。")));
    }
    let image = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| invalid("图片数据损坏。"))?
        .to_rgba8();
    if !image.pixels().any(|p| p[3] == 0) || !image.pixels().any(|p| p[3] != 0) {
        return Err(invalid("图片必须同时包含透明背景和可见形象。"));
    }
    Ok(())
}

fn validate_manifest(value: &Value, files: &BTreeSet<String>) -> AppResult<Capabilities> {
    if value["schemaVersion"] != 1
        || value["spriteVersionNumber"] != 2
        || value["cellWidth"] != 192
        || value["cellHeight"] != 208
        || value["columns"] != 8
        || value["rows"] != 11
        || value["lifeRows"] != 21
        || value["assetLicense"] != "LICENSE.txt"
    {
        return Err(invalid("宠物包版本、尺寸或许可引用不正确。"));
    }
    nickname(
        value["displayName"]
            .as_str()
            .ok_or_else(|| invalid("宠物包缺少名称。"))?,
    )?;
    let capabilities = Capabilities {
        learning: files.contains("learning-atlas.webp"),
        scene: files.contains("scene-atlas.webp"),
    };
    for (key, file, present) in [
        ("spritesheet", "spritesheet.webp", true),
        ("sleepSpritesheet", "sleep-atlas.webp", true),
        ("lifeSpritesheet", "life-atlas.webp", true),
        (
            "learningSpritesheet",
            "learning-atlas.webp",
            capabilities.learning,
        ),
        ("sceneSpritesheet", "scene-atlas.webp", capabilities.scene),
    ] {
        if (present && value[key] != file) || (!present && !value[key].is_null()) {
            return Err(invalid("图集引用必须与包内固定文件一致。"));
        }
    }
    if (capabilities.learning && value["learningRows"] != 4)
        || (capabilities.scene && value["sceneRows"] != 18)
    {
        return Err(invalid("扩展动作行数不正确。"));
    }
    let animations = value["animations"]
        .as_object()
        .ok_or_else(|| invalid("缺少动画清单。"))?;
    let reference = builtin_summary().manifest;
    let reference = reference["animations"].as_object().unwrap();
    for (name, standard) in reference {
        let sheet = standard["sheet"].as_str().unwrap_or("standard");
        let present = match sheet {
            "learning" => capabilities.learning,
            "scene" => capabilities.scene,
            _ => true,
        };
        if !present {
            if animations.contains_key(name) {
                return Err(invalid("缺少图集时不能声明其动画。"));
            }
            continue;
        }
        let def = animations
            .get(name)
            .ok_or_else(|| invalid(format!("缺少动作：{name}")))?;
        if def["sheet"].as_str().unwrap_or("standard") != sheet || def["row"] != standard["row"] {
            return Err(invalid(format!("动作行不正确：{name}")));
        }
        let frames = def["frames"]
            .as_array()
            .ok_or_else(|| invalid("动作帧格式不正确。"))?;
        let durations = def["durations"]
            .as_array()
            .ok_or_else(|| invalid("动作时长格式不正确。"))?;
        if frames.is_empty()
            || frames.len() > 128
            || frames.len() != durations.len()
            || frames.iter().any(|x| x.as_u64().is_none_or(|n| n >= 8))
            || durations.iter().any(|x| {
                x.as_f64()
                    .is_none_or(|n| !n.is_finite() || !(10.0..=10000.0).contains(&n))
            })
            || def["staticFrame"].as_u64().is_none_or(|n| n >= 8)
        {
            return Err(invalid(format!("动作帧或时长不正确：{name}")));
        }
        if !def["loopStart"].is_null()
            && def["loopStart"]
                .as_u64()
                .is_none_or(|n| n >= frames.len() as u64)
        {
            return Err(invalid("循环起点越界。"));
        }
        if def["loopStart"].is_null() != standard["loopStart"].is_null() {
            return Err(invalid("动作循环语义与播放器不兼容。"));
        }
    }
    if animations.keys().any(|key| !reference.contains_key(key)) {
        return Err(invalid("宠物包含有未知动作。"));
    }
    Ok(capabilities)
}

fn inspect(directory: &Path) -> AppResult<Pack> {
    plain(directory, true)?;
    let mut hashes = BTreeMap::new();
    let mut manifest = None;
    let mut total = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| invalid("文件名不正确。"))?;
        if !FILES.contains(&name.as_str()) {
            return Err(invalid("宠物包含有未允许的文件。"));
        }
        let bytes = bounded_read(&entry.path(), file_limit(&name))?;
        total += bytes.len() as u64;
        if total > LIMIT {
            return Err(invalid("宠物包超过 64 MiB。"));
        }
        validate_image(&name, &bytes)?;
        if name == "pet-pack.json" {
            manifest = Some(serde_json::from_slice::<Value>(&bytes)?);
        }
        if name == "LICENSE.txt"
            && std::str::from_utf8(&bytes)
                .ok()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(invalid("许可说明必须是非空 UTF-8 文本。"));
        }
        hashes.insert(name, digest(&bytes));
    }
    if REQUIRED.iter().any(|name| !hashes.contains_key(*name)) {
        return Err(invalid("宠物包缺少基础图集、静态图或许可文件。"));
    }
    let manifest = manifest.ok_or_else(|| invalid("缺少清单。"))?;
    let capabilities = validate_manifest(&manifest, &hashes.keys().cloned().collect())?;
    let id = content_id(&hashes);
    Ok(Pack {
        summary: PackSummary {
            pack_id: id,
            display_name: nickname(manifest["displayName"].as_str().unwrap())?,
            builtin: false,
            capabilities,
            manifest,
            fallback_image: String::new(),
        },
        directory: directory.to_path_buf(),
        hashes,
    })
}

fn resolved(pack: &Pack, resource_id: &str) -> PackSummary {
    let mut result = pack.summary.clone();
    let url = |file: &str| format!("http://petasset.localhost/{resource_id}/{file}");
    for key in [
        "spritesheet",
        "sleepSpritesheet",
        "lifeSpritesheet",
        "learningSpritesheet",
        "sceneSpritesheet",
    ] {
        if let Some(file) = result.manifest[key].as_str().map(str::to_owned) {
            result.manifest[key] = json!(url(&file));
        }
    }
    result.fallback_image = url("fallback.png");
    result
}

impl PetStore {
    pub fn open(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&root)?;
        plain(&root, true)?;
        let pending = root.join(".pending");
        fs::create_dir_all(&pending)?;
        plain(&pending, true)?;
        // Only our UUID-named direct staging children are eligible for cleanup.
        for entry in fs::read_dir(&pending)? {
            let entry = entry?;
            if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
                && plain(&entry.path(), true).is_ok()
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        let mut store = Self {
            root,
            revision: 1,
            packs: BTreeMap::new(),
            pending: BTreeMap::new(),
            failures: BTreeMap::new(),
        };
        for entry in fs::read_dir(&store.root)? {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().to_string();
            if id != BUILTIN && valid_id(&id) {
                if let Ok(pack) = inspect(&entry.path()) {
                    if pack.summary.pack_id == id {
                        store.packs.insert(id, pack);
                    }
                }
            }
        }
        Ok(store)
    }
    pub fn check_revision(&self, revision: u64) -> AppResult<()> {
        if revision != self.revision {
            Err(invalid("宠物配置已变化，请刷新后重试。"))
        } else {
            Ok(())
        }
    }
    pub fn bump(&mut self) {
        self.revision += 1;
    }
    pub fn catalog(&self) -> Vec<PackSummary> {
        std::iter::once(builtin_summary())
            .chain(self.packs.iter().map(|(id, pack)| resolved(pack, id)))
            .collect()
    }
    pub fn snapshot(&self, profile: &PetProfile) -> ProfileSnapshot {
        let selected = &profile.selected_pack_id;
        let failures = self.failures.get(selected);
        let unusable = failures.is_some_and(|x| x.contains("fallback"));
        let mut pack = self
            .packs
            .get(selected)
            .filter(|_| !unusable)
            .map(|p| resolved(p, selected))
            .unwrap_or_else(builtin_summary);
        if let Some(failures) = failures {
            if failures.contains("learning") {
                pack.capabilities.learning = false;
            }
            if failures.contains("scene") {
                pack.capabilities.scene = false;
            }
        }
        let static_only = failures.is_some_and(|x| {
            x.iter()
                .any(|s| ["standard", "sleep", "life"].contains(&s.as_str()))
        }) && (pack.pack_id == *selected);
        let fallback_reason = if pack.pack_id != *selected {
            Some("所选宠物包缺失或损坏，暂时使用圆圆。重新导入原包后会恢复原选择。".into())
        } else if static_only {
            Some("图集暂不可用，正在显示这只宠物的静态形象。".into())
        } else {
            None
        };
        ProfileSnapshot {
            revision: self.revision,
            selected_pack_id: selected.clone(),
            effective_pack_id: pack.pack_id.clone(),
            nickname: profile
                .nicknames
                .get(&pack.pack_id)
                .cloned()
                .unwrap_or(pack.display_name),
            capabilities: pack.capabilities,
            manifest: pack.manifest,
            fallback_image: pack.fallback_image,
            fallback_reason,
            static_only,
        }
    }
    pub fn ensure_pack(&self, id: &str) -> AppResult<()> {
        if id == BUILTIN {
            return Ok(());
        }
        let pack = self
            .packs
            .get(id)
            .ok_or_else(|| invalid("宠物包不存在。"))?;
        let fresh = inspect(&pack.directory)?;
        if fresh.summary.pack_id != id {
            return Err(invalid("宠物包内容已改变，请重新导入。"));
        }
        Ok(())
    }
    pub fn ensure_known(&self, id: &str) -> AppResult<()> {
        if id == BUILTIN || self.packs.contains_key(id) {
            Ok(())
        } else {
            Err(invalid("宠物包不存在。"))
        }
    }
    pub fn preview(&mut self, source: &Path) -> AppResult<ImportPreview> {
        if source.extension().and_then(|s| s.to_str()) != Some("yuanyuan-pet") {
            return Err(invalid("请选择 .yuanyuan-pet 文件。"));
        }
        let data = bounded_read(source, LIMIT)?;
        if self.pending.len() >= 4 {
            return Err(invalid("请先关闭已有导入预览。"));
        }
        plain(&self.root, true)?;
        plain(&self.root.join(".pending"), true)?;
        let token = uuid::Uuid::new_v4().to_string();
        let destination = self.root.join(".pending").join(&token);
        fs::create_dir(&destination)?;
        let result = (|| {
            for (name, bytes) in read_archive(&data, REQUIRED.len())? {
                fs::write(destination.join(&name), bytes)?;
            }
            let pack = inspect(&destination)?;
            let result = ImportPreview {
                token: token.clone(),
                pack: resolved(&pack, &token),
                license: fs::read_to_string(destination.join("LICENSE.txt"))?,
                already_installed: self.packs.contains_key(&pack.summary.pack_id),
            };
            self.pending.insert(token.clone(), pack);
            Ok(result)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&destination);
        }
        result
    }
    pub fn cancel(&mut self, token: &str) -> AppResult<()> {
        if let Some(pack) = self.pending.remove(token) {
            plain(&pack.directory, true)?;
            fs::remove_dir_all(pack.directory)?;
        }
        Ok(())
    }
    pub fn commit(&mut self, token: &str) -> AppResult<PackSummary> {
        let result = self.commit_checked(token);
        if result.is_err() {
            let _ = self.cancel(token);
        }
        result
    }
    fn commit_checked(&mut self, token: &str) -> AppResult<PackSummary> {
        let pending = self
            .pending
            .get(token)
            .ok_or_else(|| invalid("导入预览已失效。"))?
            .clone();
        let fresh = inspect(&pending.directory)?;
        if fresh.hashes != pending.hashes {
            self.cancel(token)?;
            return Err(invalid("预览内容已改变，请重新导入。"));
        }
        let id = fresh.summary.pack_id.clone();
        if self.packs.contains_key(&id) && self.ensure_pack(&id).is_ok() {
            self.cancel(token)?;
            self.clear_failures(&id);
            self.bump();
            return Ok(resolved(self.packs.get(&id).unwrap(), &id));
        }
        plain(&self.root, true)?;
        let destination = self.root.join(&id);
        let quarantine = self
            .root
            .join(".pending")
            .join(uuid::Uuid::new_v4().to_string());
        let replacing = destination.exists();
        if replacing {
            plain(&destination, true)?;
            for entry in fs::read_dir(&destination)? {
                let entry = entry?;
                if !FILES.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    return Err(invalid("损坏目录包含未知文件，无法自动替换。"));
                }
                plain(&entry.path(), false)?;
            }
            fs::rename(&destination, &quarantine)?;
        }
        if let Err(error) = fs::rename(&pending.directory, &destination) {
            if replacing {
                fs::rename(&quarantine, &destination)?;
            }
            return Err(error.into());
        }
        if replacing {
            let _ = fs::remove_dir_all(&quarantine);
        }
        self.pending.remove(token);
        let mut pack = fresh;
        pack.directory = destination;
        let summary = resolved(&pack, &id);
        self.clear_failures(&id);
        self.packs.insert(id, pack);
        self.bump();
        Ok(summary)
    }
    pub fn remove(
        &mut self,
        id: &str,
        profile: &PetProfile,
        persist: impl FnOnce(&PetProfile) -> AppResult<()>,
    ) -> AppResult<()> {
        if id == BUILTIN || id == profile.selected_pack_id {
            return Err(invalid("请先切换到其他宠物，再移除此形象。"));
        }
        let pack = self
            .packs
            .get(id)
            .ok_or_else(|| invalid("宠物包不存在。"))?;
        plain(&self.root, true)?;
        plain(&pack.directory, true)?;
        let staging = self.root.join(".pending");
        plain(&staging, true)?;
        let removed = staging.join(uuid::Uuid::new_v4().to_string());
        fs::rename(&pack.directory, &removed)?;
        let mut next = profile.clone();
        next.nicknames.remove(id);
        if let Err(error) = persist(&next) {
            fs::rename(&removed, &pack.directory)?;
            return Err(error);
        }
        self.packs.remove(id);
        self.failures.remove(id);
        self.bump();
        // A locked cleanup file remains in our staging area until next startup.
        let _ = fs::remove_dir_all(removed);
        Ok(())
    }
    pub fn clear_failures(&mut self, id: &str) {
        self.failures.remove(id);
    }
    pub fn report_failure(&mut self, id: &str, sheet: &str) -> AppResult<()> {
        if !["standard", "sleep", "life", "learning", "scene", "fallback"].contains(&sheet)
            || (id != BUILTIN && !self.packs.contains_key(id))
        {
            return Err(invalid("未知素材。"));
        }
        if self
            .failures
            .entry(id.into())
            .or_default()
            .insert(sheet.into())
        {
            self.bump();
        }
        Ok(())
    }
    pub fn resource(&self, id: &str, name: &str) -> AppResult<Vec<u8>> {
        if !FILES.contains(&name) || !["png", "webp"].iter().any(|ext| name.ends_with(ext)) {
            return Err(invalid("未知图片资源。"));
        }
        let pack = self
            .packs
            .get(id)
            .or_else(|| self.pending.get(id))
            .ok_or_else(|| invalid("图片资源已失效。"))?;
        plain(&self.root, true)?;
        plain(&pack.directory, true)?;
        let bytes = bounded_read(&pack.directory.join(name), file_limit(name))?;
        if pack.hashes.get(name) != Some(&digest(&bytes)) {
            return Err(invalid("图片内容已改变。"));
        }
        Ok(bytes)
    }
}
