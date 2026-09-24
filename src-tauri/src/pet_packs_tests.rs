use super::*;
use std::io::Write;

#[cfg(feature = "pet-repair-tools")]
#[test]
fn repair_validation_matches_production_for_valid_and_broken_packages() {
    let root = tempfile::tempdir().unwrap();
    let mut store = PetStore::open(root.path().join("store")).unwrap();
    for complete in [false, true] {
        let package = fixture(root.path(), complete, complete);
        let original = fs::read(&package).unwrap();
        for (index, problem) in [
            "valid",
            "json",
            "missing",
            "decode",
            "static",
            "duplicate",
            "traversal",
            "limit",
        ]
        .iter()
        .enumerate()
        {
            let mut files = read_archive(&original, REQUIRED.len()).unwrap();
            match *problem {
                "json" => {
                    files.insert("pet-pack.json".into(), b"{".to_vec());
                }
                "missing" => {
                    files.remove("fallback.png");
                }
                "decode" => {
                    files.insert("fallback.png".into(), b"invalid png".to_vec());
                }
                "static" => {
                    let mut man: Value = serde_json::from_slice(&files["pet-pack.json"]).unwrap();
                    man["animations"]["idle"]
                        .as_object_mut()
                        .unwrap()
                        .remove("staticFrame");
                    files.insert("pet-pack.json".into(), serde_json::to_vec(&man).unwrap());
                }
                "traversal" => {
                    files.insert("../LICENSE.txt".into(), b"MIT".to_vec());
                }
                "limit" => {
                    files.insert("LICENSE.txt".into(), vec![32; 65537]);
                }
                _ => {}
            }
            let input = root
                .path()
                .join(format!("sample-{complete}-{index}.yuanyuan-pet"));
            write_zip(&input, &files);
            if *problem == "duplicate" {
                fs::write(
                    &input,
                    repeat_central_entry(&fs::read(&input).unwrap(), "LICENSE.txt"),
                )
                .unwrap();
            }
            let before = fs::read(&input).unwrap();
            let output = root.path().join(format!("extract-{complete}-{index}"));
            let result = repair_tools_run("extract", &input, Some(&output));
            let production = store.preview(&input);
            let tool_accepts = result
                .as_ref()
                .is_ok_and(|r| r["validation"]["valid"] == true);
            assert_eq!(tool_accepts, production.is_ok(), "{problem}");
            if let Ok(preview) = production {
                store.cancel(&preview.token).unwrap();
            }
            if ["duplicate", "traversal", "limit"].contains(problem) {
                assert!(result.is_err());
                assert!(!output.exists());
            } else {
                let result = result.unwrap();
                assert_eq!(
                    repair_tools_run("validate", &output, None).unwrap(),
                    result["validation"]
                );
                assert!(repair_tools_run("extract", &input, Some(&output)).is_err());
            }
            assert_eq!(fs::read(&input).unwrap(), before);
        }
    }
}

fn fixture(root: &Path, learning: bool, scene: bool) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/assets/pet");
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(source.join("pet-manifest.json")).unwrap()).unwrap();
    manifest["schemaVersion"] = json!(1);
    manifest["assetLicense"] = json!("LICENSE.txt");
    manifest["displayName"] = json!("测试宠物");
    let mut files = BTreeMap::new();
    for (key, file, include) in [
        ("spritesheet", "spritesheet.webp", true),
        ("sleepSpritesheet", "sleep-atlas.webp", true),
        ("lifeSpritesheet", "life-atlas.webp", true),
        ("learningSpritesheet", "learning-atlas.webp", learning),
        ("sceneSpritesheet", "scene-atlas.webp", scene),
    ] {
        if include {
            manifest[key] = json!(file);
            files.insert(file.to_owned(), fs::read(source.join(file)).unwrap());
        } else {
            manifest.as_object_mut().unwrap().remove(key);
            let sheet = if key == "learningSpritesheet" {
                "learning"
            } else {
                "scene"
            };
            manifest["animations"]
                .as_object_mut()
                .unwrap()
                .retain(|_, def| def["sheet"] != sheet);
        }
    }
    files.insert(
        "pet-pack.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    files.insert(
        "fallback.png".into(),
        fs::read(source.join("fallback.png")).unwrap(),
    );
    files.insert(
        "LICENSE.txt".into(),
        b"Local test fixture; existing project asset license applies.".to_vec(),
    );
    let output = root.join(format!("fixture-{learning}-{scene}.yuanyuan-pet"));
    write_zip(&output, &files);
    output
}
fn write_zip(path: &Path, files: &BTreeMap<String, Vec<u8>>) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in files {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

// ZipWriter forbids duplicate names, but an untrusted ZIP can repeat a central
// directory entry. zip 2.4.2 silently folds those entries into its name map.
fn repeat_central_entry(bytes: &[u8], name: &str) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let entry_start = archive.by_name(name).unwrap().central_header_start() as usize;
    let u16_at = |offset| u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
    let entry_length = 46
        + usize::from(u16_at(entry_start + 28))
        + usize::from(u16_at(entry_start + 30))
        + usize::from(u16_at(entry_start + 32));
    let end = bytes.len() - 22;
    assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
    let count = u16_at(end + 10) + 1;
    let size = u32::from_le_bytes(bytes[end + 12..end + 16].try_into().unwrap());
    let mut result = bytes[..end].to_vec();
    result.extend_from_slice(&bytes[entry_start..entry_start + entry_length]);
    let new_end = result.len();
    result.extend_from_slice(&bytes[end..]);
    result[new_end + 8..new_end + 10].copy_from_slice(&count.to_le_bytes());
    result[new_end + 10..new_end + 12].copy_from_slice(&count.to_le_bytes());
    result[new_end + 12..new_end + 16].copy_from_slice(&(size + entry_length as u32).to_le_bytes());
    result
}

#[test]
fn repeated_central_directory_names_are_rejected_without_staging_or_selection_changes() {
    let root = tempfile::tempdir().unwrap();
    let mut store = PetStore::open(root.path().join("packs")).unwrap();
    let profile = PetProfile::default();
    let revision = store.revision;
    for complete in [false, true] {
        let valid = fixture(root.path(), complete, complete);
        let original = fs::read(&valid).unwrap();
        for name in ["LICENSE.txt", "pet-pack.json"] {
            let data = repeat_central_entry(&original, name);
            let path = root.path().join("duplicate.yuanyuan-pet");
            fs::write(&path, &data).unwrap();
            // Reproduce the library behavior that defeated the old seen-set.
            let archive = zip::ZipArchive::new(Cursor::new(&data)).unwrap();
            assert_eq!(archive.len(), if complete { 8 } else { 6 });
            assert!(store.preview(&path).is_err(), "duplicate {name} accepted");
            assert!(store.pending.is_empty());
            assert_eq!(
                fs::read_dir(store.root.join(".pending")).unwrap().count(),
                0
            );
            assert_eq!(store.catalog().len(), 1);
            assert_eq!(store.revision, revision);
            assert_eq!(store.snapshot(&profile).effective_pack_id, BUILTIN);
            assert_eq!(fs::read(&path).unwrap(), data);
        }
    }
}

#[test]
fn raw_directory_scan_bounds_names_lengths_and_entry_counts() {
    let mut directory = Vec::new();
    for name in REQUIRED {
        let mut header = [0u8; 46];
        header[..4].copy_from_slice(b"PK\x01\x02");
        header[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        // Legal per-entry extra fields and comments must not look like entries.
        header[30..32].copy_from_slice(&4u16.to_le_bytes());
        header[32..34].copy_from_slice(&4u16.to_le_bytes());
        directory.extend_from_slice(&header);
        directory.extend_from_slice(name.as_bytes());
        directory.extend_from_slice(b"\x00\x00\x00\x00PK\x01\x02");
    }
    directory.extend_from_slice(b"PK\x05\x06");
    assert!(validate_archive_directory(&directory, 0, REQUIRED.len(), REQUIRED.len()).is_ok());
    assert!(validate_archive_directory(&directory, 0, REQUIRED.len() - 1, REQUIRED.len()).is_err());
    assert!(validate_archive_directory(&directory, 0, REQUIRED.len() + 1, REQUIRED.len()).is_err());
    assert!(
        validate_archive_directory(&directory, u64::MAX, REQUIRED.len(), REQUIRED.len()).is_err()
    );
    for end in 0..46 + REQUIRED[0].len() + 8 {
        assert!(
            validate_archive_directory(&directory[..end], 0, REQUIRED.len(), REQUIRED.len())
                .is_err()
        );
    }
    let mut invalid_name = directory.clone();
    invalid_name[46] = b'/';
    assert!(validate_archive_directory(&invalid_name, 0, REQUIRED.len(), REQUIRED.len()).is_err());
    let mut oversized_name = directory;
    oversized_name[28..30].copy_from_slice(&u16::MAX.to_le_bytes());
    assert!(
        validate_archive_directory(&oversized_name, 0, REQUIRED.len(), REQUIRED.len()).is_err()
    );
}
#[test]
fn nickname_unicode_limits_and_controls() {
    assert!(nickname("团\u{2028}子").is_err());
    assert!(nickname("团子\u{2029}").is_err());
    assert_eq!(nickname("  小猫🐈  ").unwrap(), "小猫🐈");
    for name in ["", "  ", "猫\n", "\t猫", "猫\u{85}", &"猫".repeat(25)] {
        assert!(nickname(name).is_err());
    }
    assert!(nickname(&"🐈".repeat(24)).is_ok());
    assert_eq!(nickname("\u{2003}团子\u{3000}").unwrap(), "团子");
    assert_eq!(
        nickname("\u{feff}团子\u{feff}").unwrap(),
        "\u{feff}团子\u{feff}"
    );
}
#[test]
fn old_settings_and_stale_window_save_keep_profile() {
    let root = tempfile::tempdir().unwrap();
    let repo = crate::repository::Repository::open(&root.path().join("data.sqlite3")).unwrap();
    let stale = repo.get_settings().unwrap();
    assert_eq!(stale.pet_profile, PetProfile::default());
    let mut profile = PetProfile::default();
    profile.nicknames.insert(BUILTIN.into(), "汤圆".into());
    repo.save_pet_profile(&profile).unwrap();
    repo.save_settings(&stale).unwrap();
    repo.update_settings(json!({"petWidth": 200})).unwrap();
    assert_eq!(repo.get_settings().unwrap().pet_profile, profile);
    assert!(repo.update_settings(json!({"petProfile": {}})).is_err());
    let old: crate::models::AppSettings =
        serde_json::from_value(json!({"animationMode":"off"})).unwrap();
    assert_eq!(old.pet_profile, PetProfile::default());
}
#[test]
fn imports_optional_capabilities_deduplicates_and_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let store_root = root.path().join("pet-packs");
    let mut store = PetStore::open(store_root.clone()).unwrap();
    for (learning, scene) in [(true, true), (false, true), (true, false), (false, false)] {
        let archive = fixture(root.path(), learning, scene);
        let preview = store.preview(&archive).unwrap();
        assert_eq!(preview.pack.capabilities, Capabilities { learning, scene });
        assert_eq!(store.catalog().len(), 1 + store.packs.len());
        let pack = store.commit(&preview.token).unwrap();
        let again = store.preview(&archive).unwrap();
        assert!(again.already_installed);
        assert_eq!(store.commit(&again.token).unwrap().pack_id, pack.pack_id);
        assert!(store.commit(&again.token).is_err());
        let profile = PetProfile {
            selected_pack_id: pack.pack_id.clone(),
            ..PetProfile::default()
        };
        assert_eq!(store.snapshot(&profile).effective_pack_id, pack.pack_id);
        assert!(store.remove(&pack.pack_id, &profile, |_| Ok(())).is_err());
    }
    let restarted = PetStore::open(store_root).unwrap();
    assert_eq!(restarted.catalog().len(), 5);
}
#[test]
fn cancel_tamper_corruption_and_missing_backup_resources() {
    let root = tempfile::tempdir().unwrap();
    let mut store = PetStore::open(root.path().join("packs")).unwrap();
    let archive = fixture(root.path(), false, false);
    let preview = store.preview(&archive).unwrap();
    store.cancel(&preview.token).unwrap();
    assert!(store.commit(&preview.token).is_err());
    let preview = store.preview(&archive).unwrap();
    fs::write(
        store.pending[&preview.token].directory.join("LICENSE.txt"),
        "changed",
    )
    .unwrap();
    assert!(store.commit(&preview.token).is_err());
    let preview = store.preview(&archive).unwrap();
    let pack = store.commit(&preview.token).unwrap();
    let mut profile = PetProfile {
        selected_pack_id: pack.pack_id.clone(),
        ..PetProfile::default()
    };
    profile
        .nicknames
        .insert(pack.pack_id.clone(), "独立昵称".into());
    assert_eq!(store.snapshot(&profile).nickname, "独立昵称");
    store.report_failure(&pack.pack_id, "life").unwrap();
    assert!(store.snapshot(&profile).static_only);
    store.report_failure(&pack.pack_id, "fallback").unwrap();
    assert_eq!(store.snapshot(&profile).effective_pack_id, BUILTIN);
    assert_eq!(store.snapshot(&profile).selected_pack_id, pack.pack_id);
    assert!(store.resource(&pack.pack_id, "../LICENSE.txt").is_err());
    assert!(store.resource(&pack.pack_id, "LICENSE.txt").is_err());
    fs::write(
        store.packs[&pack.pack_id]
            .directory
            .join("spritesheet.webp"),
        b"broken",
    )
    .unwrap();
    assert!(store.ensure_pack(&pack.pack_id).is_err());
    assert!(store.resource(&pack.pack_id, "spritesheet.webp").is_err());
    assert!(store.check_revision(store.revision - 1).is_err());
    // Reimport repairs the immutable content address, including after a restart.
    let store_root = store.root.clone();
    drop(store);
    let mut store = PetStore::open(store_root).unwrap();
    assert_eq!(store.snapshot(&profile).effective_pack_id, BUILTIN);
    let preview = store.preview(&archive).unwrap();
    assert_eq!(
        store.commit(&preview.token).unwrap().pack_id,
        profile.selected_pack_id
    );
    assert_eq!(store.snapshot(&profile).nickname, "独立昵称");
    assert!(!store.snapshot(&profile).static_only);
}

#[test]
fn backup_restores_selection_and_names_without_touching_assets() {
    let root = tempfile::tempdir().unwrap();
    let mut repo = crate::repository::Repository::open(&root.path().join("data.sqlite3")).unwrap();
    let mut store = PetStore::open(root.path().join("pet-packs")).unwrap();
    let archive = fixture(root.path(), false, false);
    let preview = store.preview(&archive).unwrap();
    let pack = store.commit(&preview.token).unwrap();
    let mut profile = PetProfile {
        selected_pack_id: pack.pack_id.clone(),
        ..PetProfile::default()
    };
    profile.nicknames.insert(BUILTIN.into(), "汤圆".into());
    profile
        .nicknames
        .insert(pack.pack_id.clone(), "团子".into());
    repo.save_pet_profile(&profile).unwrap();
    let backups = root.path().join("backups");
    let backup = crate::backups::create_manual_backup(&repo, &backups).unwrap();
    repo.save_pet_profile(&PetProfile::default()).unwrap();
    crate::backups::restore_backup(&mut repo, &backups, &backup.file_name).unwrap();
    assert_eq!(repo.get_settings().unwrap().pet_profile, profile);
    assert_eq!(store.snapshot(&profile).nickname, "团子");
    assert!(store.resource(&pack.pack_id, "fallback.png").is_ok());
    profile.selected_pack_id = BUILTIN.into();
    assert_eq!(store.snapshot(&profile).nickname, "汤圆");
    let revision = store.revision;
    assert!(store
        .remove(&pack.pack_id, &profile, |_| Err(invalid(
            "simulated settings write failure"
        )))
        .is_err());
    assert_eq!(store.revision, revision);
    assert!(store.resource(&pack.pack_id, "fallback.png").is_ok());
    store.remove(&pack.pack_id, &profile, |_| Ok(())).unwrap();
    profile.selected_pack_id = pack.pack_id.clone();
    assert_eq!(store.snapshot(&profile).effective_pack_id, BUILTIN);
    assert_eq!(store.snapshot(&profile).selected_pack_id, pack.pack_id);
    assert!(archive.exists());
}
#[test]
fn zip_paths_extra_content_and_manifest_external_urls_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let mut store = PetStore::open(root.path().join("packs")).unwrap();
    for name in [
        "../outside",
        "C:/outside",
        "a/b",
        "script.js",
        "Spritesheet.webp",
    ] {
        let mut files: BTreeMap<String, Vec<u8>> = REQUIRED
            .iter()
            .map(|name| (name.to_string(), vec![1]))
            .collect();
        files.insert(name.into(), vec![1]);
        let path = root.path().join("bad.yuanyuan-pet");
        write_zip(&path, &files);
        assert!(store.preview(&path).is_err());
    }
    let mut value = builtin_summary().manifest;
    value["schemaVersion"] = json!(1);
    value["assetLicense"] = json!("LICENSE.txt");
    let files = FILES.iter().map(|name| name.to_string()).collect();
    assert!(validate_manifest(&value, &files).is_err());
    assert_eq!(store.catalog().len(), 1);
}
