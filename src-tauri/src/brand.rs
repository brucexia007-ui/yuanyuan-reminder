use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandDocument {
    schema_version: u32,
    pet: PetBrand,
    application: ApplicationBrand,
    storage: StorageBrand,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetBrand {
    display_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationBrand {
    display_name: String,
    identifier: String,
    window_titles: WindowTitles,
    notification_sender: String,
}

#[derive(Debug, Deserialize)]
struct WindowTitles {
    tray: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageBrand {
    directory_name: String,
    main_database_file: String,
    learning_database_file: String,
    log_file: String,
}

fn brand() -> &'static BrandDocument {
    static BRAND: OnceLock<BrandDocument> = OnceLock::new();
    BRAND.get_or_init(|| {
        let document: BrandDocument =
            serde_json::from_str(include_str!("../../product-brand.json"))
                .expect("product-brand.json must be valid");
        assert_eq!(
            document.schema_version, 1,
            "unsupported product brand schema"
        );
        document
    })
}

pub fn pet_display_name() -> &'static str {
    &brand().pet.display_name
}

pub fn application_display_name() -> &'static str {
    &brand().application.display_name
}

pub fn application_identifier() -> &'static str {
    &brand().application.identifier
}

pub fn tray_title() -> &'static str {
    &brand().application.window_titles.tray
}

pub fn notification_sender() -> &'static str {
    &brand().application.notification_sender
}

pub fn storage_directory_name() -> &'static str {
    &brand().storage.directory_name
}

pub fn main_database_file() -> &'static str {
    &brand().storage.main_database_file
}

pub fn learning_database_file() -> &'static str {
    &brand().storage.learning_database_file
}

pub fn log_file() -> &'static str {
    &brand().storage.log_file
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_brand_keeps_identity_and_storage_isolated() {
        assert_eq!(application_identifier(), storage_directory_name());
        assert!(!application_display_name().is_empty());
        assert!(!pet_display_name().is_empty());
        assert!(main_database_file().ends_with(".sqlite3"));
        assert!(learning_database_file().ends_with(".sqlite3"));
        assert!(log_file().ends_with(".log"));
    }
}
