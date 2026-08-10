use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SUPPORT_RESOURCE_PACK_SCHEMA_VERSION: u16 = 1;
pub const MAX_SUPPORT_RESOURCE_PACK_BYTES: usize = 64 * 1024;
pub const MAX_SUPPORT_PACK_REVIEW_INTERVAL_MS: i64 = 180 * 24 * 60 * 60 * 1_000;

const MAX_ID_BYTES: usize = 96;
const MAX_REGION_BYTES: usize = 32;
const MAX_LOCALE_BYTES: usize = 32;
const MAX_LABEL_BYTES: usize = 160;
const MAX_NOTE_BYTES: usize = 512;
const MAX_URL_BYTES: usize = 2_048;
const MAX_PHONE_BYTES: usize = 32;
const MAX_RESOURCES: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SupportResourcePackV1 {
    pub schema_version: u16,
    pub pack_id: String,
    pub region: String,
    pub locale: String,
    pub reviewer_organization: String,
    pub reviewed_at_unix_ms: i64,
    pub valid_from_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub resources: Vec<SupportResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SupportResource {
    pub resource_id: String,
    pub kind: SupportResourceKind,
    pub display_name: String,
    #[serde(default)]
    pub phone_number: Option<String>,
    pub source_label: String,
    pub source_url: String,
    #[serde(default)]
    pub availability_note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportResourceKind {
    EmergencyService,
    CrisisSupport,
    MedicalFacilityGuidance,
    TrustedPersonGuidance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportFallbackReason {
    Missing,
    Invalid,
    NotYetValid,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportResourceDecision {
    Ready(SupportResourcePackV1),
    GenericFallback(SupportFallbackReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenericSafetyPanel {
    pub title: &'static str,
    pub description: &'static str,
    pub actions: [&'static str; 4],
}

pub const GENERIC_SAFETY_PANEL: GenericSafetyPanel = GenericSafetyPanel {
    title: "请立即联系现实中的帮助",
    description: "当前没有经过核验的本地联系方式。若存在紧迫危险，请联系所在地紧急服务、前往最近的急诊或医疗机构，并尽快联系你信任的人。",
    actions: [
        "联系所在地紧急服务",
        "前往最近的急诊或医疗机构",
        "联系信任的人",
        "手动选择地区",
    ],
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SupportResourceError {
    #[error("support resource pack is too large")]
    InputTooLarge,
    #[error("support resource pack is not valid JSON")]
    InvalidJson,
    #[error("support resource pack schema version is unsupported")]
    UnsupportedVersion,
    #[error("support resource pack contains invalid data")]
    InvalidData,
    #[error("support resource pack contains a duplicate identifier")]
    DuplicateIdentifier,
}

impl SupportResourcePackV1 {
    pub fn parse_and_validate(input: &[u8]) -> Result<Self, SupportResourceError> {
        if input.len() > MAX_SUPPORT_RESOURCE_PACK_BYTES {
            return Err(SupportResourceError::InputTooLarge);
        }
        let pack: Self =
            serde_json::from_slice(input).map_err(|_| SupportResourceError::InvalidJson)?;
        pack.validate()?;
        Ok(pack)
    }

    pub fn validate(&self) -> Result<(), SupportResourceError> {
        if self.schema_version != SUPPORT_RESOURCE_PACK_SCHEMA_VERSION {
            return Err(SupportResourceError::UnsupportedVersion);
        }
        validate_id(&self.pack_id)?;
        validate_region_or_locale(&self.region, MAX_REGION_BYTES)?;
        validate_region_or_locale(&self.locale, MAX_LOCALE_BYTES)?;
        validate_text(&self.reviewer_organization, MAX_LABEL_BYTES)?;
        if self.reviewed_at_unix_ms < 0
            || self.valid_from_unix_ms < self.reviewed_at_unix_ms
            || self.expires_at_unix_ms <= self.valid_from_unix_ms
            || self.expires_at_unix_ms - self.reviewed_at_unix_ms
                > MAX_SUPPORT_PACK_REVIEW_INTERVAL_MS
            || self.resources.is_empty()
            || self.resources.len() > MAX_RESOURCES
        {
            return Err(SupportResourceError::InvalidData);
        }

        let mut ids = HashSet::new();
        let mut has_emergency_service = false;
        for resource in &self.resources {
            validate_id(&resource.resource_id)?;
            if !ids.insert(resource.resource_id.as_str()) {
                return Err(SupportResourceError::DuplicateIdentifier);
            }
            validate_text(&resource.display_name, MAX_LABEL_BYTES)?;
            validate_text(&resource.source_label, MAX_LABEL_BYTES)?;
            validate_https_url(&resource.source_url)?;
            validate_optional_text(resource.availability_note.as_deref(), MAX_NOTE_BYTES)?;
            if let Some(phone) = resource.phone_number.as_deref() {
                validate_phone(phone)?;
            }
            if resource.kind == SupportResourceKind::EmergencyService {
                has_emergency_service = true;
                if resource.phone_number.is_none() {
                    return Err(SupportResourceError::InvalidData);
                }
            }
        }
        if !has_emergency_service {
            return Err(SupportResourceError::InvalidData);
        }
        Ok(())
    }
}

pub fn evaluate_support_resource_pack(
    input: Option<&[u8]>,
    now_unix_ms: i64,
) -> SupportResourceDecision {
    let Some(input) = input else {
        return SupportResourceDecision::GenericFallback(SupportFallbackReason::Missing);
    };
    let Ok(pack) = SupportResourcePackV1::parse_and_validate(input) else {
        return SupportResourceDecision::GenericFallback(SupportFallbackReason::Invalid);
    };
    if now_unix_ms < pack.valid_from_unix_ms {
        SupportResourceDecision::GenericFallback(SupportFallbackReason::NotYetValid)
    } else if now_unix_ms >= pack.expires_at_unix_ms {
        SupportResourceDecision::GenericFallback(SupportFallbackReason::Expired)
    } else {
        SupportResourceDecision::Ready(pack)
    }
}

fn validate_id(value: &str) -> Result<(), SupportResourceError> {
    validate_text(value, MAX_ID_BYTES)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
    {
        return Err(SupportResourceError::InvalidData);
    }
    Ok(())
}

fn validate_region_or_locale(value: &str, maximum: usize) -> Result<(), SupportResourceError> {
    validate_text(value, maximum)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(SupportResourceError::InvalidData);
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize) -> Result<(), SupportResourceError> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value
            .chars()
            .any(|character| matches!(character, '\0' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        return Err(SupportResourceError::InvalidData);
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, maximum: usize) -> Result<(), SupportResourceError> {
    if let Some(value) = value {
        validate_text(value, maximum)?;
    }
    Ok(())
}

fn validate_phone(value: &str) -> Result<(), SupportResourceError> {
    validate_text(value, MAX_PHONE_BYTES)?;
    if value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .count()
        < 3
        || !value.chars().all(|character| {
            character.is_ascii_digit() || matches!(character, '+' | '-' | ' ' | '(' | ')')
        })
    {
        return Err(SupportResourceError::InvalidData);
    }
    Ok(())
}

fn validate_https_url(value: &str) -> Result<(), SupportResourceError> {
    validate_text(value, MAX_URL_BYTES)?;
    let Some(authority_and_path) = value.strip_prefix("https://") else {
        return Err(SupportResourceError::InvalidData);
    };
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    if authority.is_empty()
        || !authority.contains('.')
        || authority.contains('@')
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
        || !value.is_ascii()
    {
        return Err(SupportResourceError::InvalidData);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const REVIEWED: i64 = 1_775_212_800_000;
    const VALID_FROM: i64 = REVIEWED + 1_000;
    const EXPIRES: i64 = VALID_FROM + 90 * 24 * 60 * 60 * 1_000;

    fn valid_pack() -> Value {
        json!({
            "schema_version": 1,
            "pack_id": "cn-zh-v1",
            "region": "CN",
            "locale": "zh-CN",
            "reviewer_organization": "合成测试审核机构",
            "reviewed_at_unix_ms": REVIEWED,
            "valid_from_unix_ms": VALID_FROM,
            "expires_at_unix_ms": EXPIRES,
            "resources": [{
                "resource_id": "emergency-test",
                "kind": "emergency_service",
                "display_name": "合成紧急服务",
                "phone_number": "+86 000",
                "source_label": "合成权威来源",
                "source_url": "https://authority.invalid/emergency",
                "availability_note": "仅用于契约测试，不是真实联系方式"
            }]
        })
    }

    #[test]
    fn a_reviewed_current_pack_is_the_only_path_that_exposes_contacts() {
        let bytes = serde_json::to_vec(&valid_pack()).unwrap();
        let decision = evaluate_support_resource_pack(Some(&bytes), VALID_FROM + 1);
        let SupportResourceDecision::Ready(pack) = decision else {
            panic!("valid pack should be ready");
        };
        assert_eq!(pack.resources[0].phone_number.as_deref(), Some("+86 000"));
    }

    #[test]
    fn missing_future_and_expired_packs_use_the_number_free_generic_panel() {
        assert_eq!(
            evaluate_support_resource_pack(None, VALID_FROM),
            SupportResourceDecision::GenericFallback(SupportFallbackReason::Missing)
        );
        let bytes = serde_json::to_vec(&valid_pack()).unwrap();
        assert_eq!(
            evaluate_support_resource_pack(Some(&bytes), VALID_FROM - 1),
            SupportResourceDecision::GenericFallback(SupportFallbackReason::NotYetValid)
        );
        assert_eq!(
            evaluate_support_resource_pack(Some(&bytes), EXPIRES),
            SupportResourceDecision::GenericFallback(SupportFallbackReason::Expired)
        );
        assert!(!GENERIC_SAFETY_PANEL
            .description
            .chars()
            .any(|character| character.is_ascii_digit()));
    }

    #[test]
    fn invalid_phone_url_or_missing_emergency_service_hides_the_entire_pack() {
        let mut phone = valid_pack();
        phone["resources"][0]["phone_number"] = json!("call <script>");
        let bytes = serde_json::to_vec(&phone).unwrap();
        assert_eq!(
            evaluate_support_resource_pack(Some(&bytes), VALID_FROM + 1),
            SupportResourceDecision::GenericFallback(SupportFallbackReason::Invalid)
        );

        let mut url = valid_pack();
        url["resources"][0]["source_url"] = json!("http://untrusted.invalid");
        let bytes = serde_json::to_vec(&url).unwrap();
        assert!(matches!(
            evaluate_support_resource_pack(Some(&bytes), VALID_FROM + 1),
            SupportResourceDecision::GenericFallback(SupportFallbackReason::Invalid)
        ));

        let mut no_emergency = valid_pack();
        no_emergency["resources"][0]["kind"] = json!("trusted_person_guidance");
        no_emergency["resources"][0]["phone_number"] = Value::Null;
        let bytes = serde_json::to_vec(&no_emergency).unwrap();
        assert!(matches!(
            evaluate_support_resource_pack(Some(&bytes), VALID_FROM + 1),
            SupportResourceDecision::GenericFallback(SupportFallbackReason::Invalid)
        ));
    }

    #[test]
    fn duplicate_ids_bidi_controls_and_overlong_review_intervals_fail_closed() {
        let mut duplicate = valid_pack();
        let resource = duplicate["resources"][0].clone();
        duplicate["resources"]
            .as_array_mut()
            .unwrap()
            .push(resource);
        let bytes = serde_json::to_vec(&duplicate).unwrap();
        assert_eq!(
            SupportResourcePackV1::parse_and_validate(&bytes),
            Err(SupportResourceError::DuplicateIdentifier)
        );

        let mut bidi = valid_pack();
        bidi["resources"][0]["display_name"] = json!("安全资源\u{202e}exe");
        let bytes = serde_json::to_vec(&bidi).unwrap();
        assert_eq!(
            SupportResourcePackV1::parse_and_validate(&bytes),
            Err(SupportResourceError::InvalidData)
        );

        let mut stale_policy = valid_pack();
        stale_policy["expires_at_unix_ms"] =
            json!(REVIEWED + MAX_SUPPORT_PACK_REVIEW_INTERVAL_MS + 1);
        let bytes = serde_json::to_vec(&stale_policy).unwrap();
        assert_eq!(
            SupportResourcePackV1::parse_and_validate(&bytes),
            Err(SupportResourceError::InvalidData)
        );
    }

    #[test]
    fn oversized_or_unknown_schema_input_never_reaches_ready_state() {
        assert_eq!(
            SupportResourcePackV1::parse_and_validate(&vec![
                b'x';
                MAX_SUPPORT_RESOURCE_PACK_BYTES + 1
            ]),
            Err(SupportResourceError::InputTooLarge)
        );
        let mut future = valid_pack();
        future["schema_version"] = json!(2);
        assert_eq!(
            SupportResourcePackV1::parse_and_validate(&serde_json::to_vec(&future).unwrap()),
            Err(SupportResourceError::UnsupportedVersion)
        );
    }
}
