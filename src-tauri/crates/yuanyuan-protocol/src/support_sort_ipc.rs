use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

pub const SUPPORT_SORT_IPC_PROTOCOL_VERSION: u16 = 1;
pub const MAX_SUPPORT_SORT_IPC_REQUEST_BYTES: usize = 20 * 1024;
pub const MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES: usize = 16 * 1024;

const MAX_REQUEST_ID_BYTES: usize = 96;
const MAX_PROVIDER_KEY_BYTES: usize = 64;
const MAX_PROVIDER_LABEL_BYTES: usize = 128;
const MAX_RETENTION_SUMMARY_BYTES: usize = 512;
const MAX_POLICY_URL_BYTES: usize = 2_048;
const MAX_USER_ENTERED_TEXT_BYTES: usize = 16 * 1024;
const MAX_RESULT_FIELD_BYTES: usize = 1_024;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SupportSortIpcRequestV1 {
    pub protocol_version: u16,
    pub request_id: String,
    /// Random per-process binding established outside this protocol. The
    /// production transport must not place it on a command line or expose it
    /// to the WebView.
    pub session_binding: String,
    pub command: SupportSortIpcCommandV1,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SupportSortIpcCommandV1 {
    DescribeProvider {
        destination: SupportSortIpcDestination,
    },
    IssueAuthorization {
        destination: SupportSortIpcDestination,
        provider_key: String,
        provider_fingerprint: String,
        disclosure_version: u16,
        disclosure_digest: String,
        user_confirmed: bool,
    },
    Submit {
        authorization_token: String,
        destination: SupportSortIpcDestination,
        provider_key: String,
        provider_fingerprint: String,
        disclosure_version: u16,
        user_entered_text: String,
    },
    Cancel {
        authorization_token: String,
    },
    RevokeAll,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportSortIpcDestination {
    LocalProvider,
    CloudProvider,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SupportSortIpcResponseV1 {
    pub protocol_version: u16,
    pub request_id: String,
    pub result: SupportSortIpcResultV1,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SupportSortIpcResultV1 {
    ProviderDescription {
        destination: SupportSortIpcDestination,
        provider_key: String,
        provider_fingerprint: String,
        provider_label: String,
        disclosure_version: u16,
        disclosure_digest: String,
        retention_summary: String,
        #[serde(default)]
        policy_url: Option<String>,
    },
    AuthorizationIssued {
        authorization_token: String,
        destination: SupportSortIpcDestination,
        provider_key: String,
        provider_fingerprint: String,
        disclosure_version: u16,
        expires_at_unix_ms: i64,
        one_use: bool,
    },
    SortCompleted {
        fact: String,
        feeling: String,
        controllable: String,
        next_step: String,
    },
    Cancelled,
    RevokedAll,
    Rejected {
        code: SupportSortIpcRejectionCode,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportSortIpcRejectionCode {
    InvalidRequest,
    IncompatibleProtocol,
    InvalidSession,
    ProviderUnavailable,
    ProviderChanged,
    AuthorizationMissingOrUsed,
    AuthorizationExpired,
    InvalidUserEnteredText,
    ProviderFailed,
    InvalidProviderOutput,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum SupportSortIpcProtocolError {
    #[error("support sort IPC message is too large")]
    InputTooLarge,
    #[error("support sort IPC message is not valid JSON")]
    InvalidJson,
    #[error("support sort IPC protocol version is unsupported")]
    UnsupportedVersion,
    #[error("support sort IPC message contains invalid data")]
    InvalidData,
}

impl Drop for SupportSortIpcRequestV1 {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

impl SupportSortIpcRequestV1 {
    fn zeroize_sensitive(&mut self) {
        self.session_binding.zeroize();
        self.command.zeroize_sensitive();
    }
}

impl Drop for SupportSortIpcCommandV1 {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

impl SupportSortIpcCommandV1 {
    fn zeroize_sensitive(&mut self) {
        match self {
            Self::DescribeProvider { .. } | Self::RevokeAll => {}
            Self::IssueAuthorization {
                provider_key,
                provider_fingerprint,
                disclosure_digest,
                ..
            } => {
                provider_key.zeroize();
                provider_fingerprint.zeroize();
                disclosure_digest.zeroize();
            }
            Self::Submit {
                authorization_token,
                provider_key,
                provider_fingerprint,
                user_entered_text,
                ..
            } => {
                authorization_token.zeroize();
                provider_key.zeroize();
                provider_fingerprint.zeroize();
                user_entered_text.zeroize();
            }
            Self::Cancel {
                authorization_token,
            } => authorization_token.zeroize(),
        }
    }
}

impl Drop for SupportSortIpcResultV1 {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

impl SupportSortIpcResultV1 {
    fn zeroize_sensitive(&mut self) {
        match self {
            Self::ProviderDescription {
                provider_key,
                provider_fingerprint,
                provider_label,
                disclosure_digest,
                retention_summary,
                policy_url,
                ..
            } => {
                provider_key.zeroize();
                provider_fingerprint.zeroize();
                provider_label.zeroize();
                disclosure_digest.zeroize();
                retention_summary.zeroize();
                if let Some(url) = policy_url {
                    url.zeroize();
                }
            }
            Self::AuthorizationIssued {
                authorization_token,
                provider_key,
                provider_fingerprint,
                ..
            } => {
                authorization_token.zeroize();
                provider_key.zeroize();
                provider_fingerprint.zeroize();
            }
            Self::SortCompleted {
                fact,
                feeling,
                controllable,
                next_step,
            } => {
                fact.zeroize();
                feeling.zeroize();
                controllable.zeroize();
                next_step.zeroize();
            }
            Self::Cancelled | Self::RevokedAll | Self::Rejected { .. } => {}
        }
    }
}

impl SupportSortIpcRequestV1 {
    pub fn parse_and_validate(input: &[u8]) -> Result<Self, SupportSortIpcProtocolError> {
        if input.len() > MAX_SUPPORT_SORT_IPC_REQUEST_BYTES {
            return Err(SupportSortIpcProtocolError::InputTooLarge);
        }
        let request: Self =
            serde_json::from_slice(input).map_err(|_| SupportSortIpcProtocolError::InvalidJson)?;
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), SupportSortIpcProtocolError> {
        validate_envelope(
            self.protocol_version,
            &self.request_id,
            &self.session_binding,
        )?;
        match &self.command {
            SupportSortIpcCommandV1::DescribeProvider { .. }
            | SupportSortIpcCommandV1::RevokeAll => Ok(()),
            SupportSortIpcCommandV1::IssueAuthorization {
                provider_key,
                provider_fingerprint,
                disclosure_version,
                disclosure_digest,
                user_confirmed,
                ..
            } => {
                validate_provider_binding(provider_key, provider_fingerprint, *disclosure_version)?;
                validate_upper_hex_digest(disclosure_digest)?;
                if !user_confirmed {
                    return Err(SupportSortIpcProtocolError::InvalidData);
                }
                Ok(())
            }
            SupportSortIpcCommandV1::Submit {
                authorization_token,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                user_entered_text,
                ..
            } => {
                validate_uuid_token(authorization_token)?;
                validate_provider_binding(provider_key, provider_fingerprint, *disclosure_version)?;
                validate_text(user_entered_text, MAX_USER_ENTERED_TEXT_BYTES)
            }
            SupportSortIpcCommandV1::Cancel {
                authorization_token,
            } => validate_uuid_token(authorization_token),
        }
    }

    pub fn to_json(&self) -> Result<Vec<u8>, SupportSortIpcProtocolError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| SupportSortIpcProtocolError::InvalidData)?;
        if bytes.len() > MAX_SUPPORT_SORT_IPC_REQUEST_BYTES {
            return Err(SupportSortIpcProtocolError::InputTooLarge);
        }
        Ok(bytes)
    }
}

impl SupportSortIpcResponseV1 {
    pub fn parse_and_validate(input: &[u8]) -> Result<Self, SupportSortIpcProtocolError> {
        if input.len() > MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES {
            return Err(SupportSortIpcProtocolError::InputTooLarge);
        }
        let response: Self =
            serde_json::from_slice(input).map_err(|_| SupportSortIpcProtocolError::InvalidJson)?;
        response.validate()?;
        Ok(response)
    }

    pub fn validate(&self) -> Result<(), SupportSortIpcProtocolError> {
        if self.protocol_version != SUPPORT_SORT_IPC_PROTOCOL_VERSION {
            return Err(SupportSortIpcProtocolError::UnsupportedVersion);
        }
        validate_identifier(&self.request_id, MAX_REQUEST_ID_BYTES)?;
        self.result.validate()
    }

    pub fn to_json(&self) -> Result<Vec<u8>, SupportSortIpcProtocolError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| SupportSortIpcProtocolError::InvalidData)?;
        if bytes.len() > MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES {
            return Err(SupportSortIpcProtocolError::InputTooLarge);
        }
        Ok(bytes)
    }
}

impl SupportSortIpcResultV1 {
    pub fn validate(&self) -> Result<(), SupportSortIpcProtocolError> {
        match self {
            Self::ProviderDescription {
                provider_key,
                provider_fingerprint,
                provider_label,
                disclosure_version,
                disclosure_digest,
                retention_summary,
                policy_url,
                ..
            } => {
                validate_provider_binding(provider_key, provider_fingerprint, *disclosure_version)?;
                validate_upper_hex_digest(disclosure_digest)?;
                validate_text(provider_label, MAX_PROVIDER_LABEL_BYTES)?;
                validate_text(retention_summary, MAX_RETENTION_SUMMARY_BYTES)?;
                if let Some(url) = policy_url {
                    validate_https_url(url)?;
                }
                Ok(())
            }
            Self::AuthorizationIssued {
                authorization_token,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                expires_at_unix_ms,
                one_use,
                ..
            } => {
                validate_uuid_token(authorization_token)?;
                validate_provider_binding(provider_key, provider_fingerprint, *disclosure_version)?;
                if *expires_at_unix_ms < 0 || !one_use {
                    return Err(SupportSortIpcProtocolError::InvalidData);
                }
                Ok(())
            }
            Self::SortCompleted {
                fact,
                feeling,
                controllable,
                next_step,
            } => {
                validate_text(fact, MAX_RESULT_FIELD_BYTES)?;
                validate_text(feeling, MAX_RESULT_FIELD_BYTES)?;
                validate_text(controllable, MAX_RESULT_FIELD_BYTES)?;
                validate_text(next_step, MAX_RESULT_FIELD_BYTES)
            }
            Self::Cancelled | Self::RevokedAll | Self::Rejected { .. } => Ok(()),
        }
    }
}

fn validate_envelope(
    protocol_version: u16,
    request_id: &str,
    session_binding: &str,
) -> Result<(), SupportSortIpcProtocolError> {
    if protocol_version != SUPPORT_SORT_IPC_PROTOCOL_VERSION {
        return Err(SupportSortIpcProtocolError::UnsupportedVersion);
    }
    validate_identifier(request_id, MAX_REQUEST_ID_BYTES)?;
    validate_upper_hex_digest(session_binding)
}

fn validate_provider_binding(
    provider_key: &str,
    provider_fingerprint: &str,
    disclosure_version: u16,
) -> Result<(), SupportSortIpcProtocolError> {
    validate_identifier(provider_key, MAX_PROVIDER_KEY_BYTES)?;
    validate_upper_hex_digest(provider_fingerprint)?;
    if disclosure_version == 0 {
        return Err(SupportSortIpcProtocolError::InvalidData);
    }
    Ok(())
}

fn validate_identifier(value: &str, maximum: usize) -> Result<(), SupportSortIpcProtocolError> {
    if value.is_empty()
        || value.len() > maximum
        || value.starts_with(['.', '_', '-'])
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(SupportSortIpcProtocolError::InvalidData);
    }
    Ok(())
}

fn validate_upper_hex_digest(value: &str) -> Result<(), SupportSortIpcProtocolError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
    {
        return Err(SupportSortIpcProtocolError::InvalidData);
    }
    Ok(())
}

fn validate_uuid_token(value: &str) -> Result<(), SupportSortIpcProtocolError> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
    {
        return Err(SupportSortIpcProtocolError::InvalidData);
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize) -> Result<(), SupportSortIpcProtocolError> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value.chars().any(|character| {
            matches!(
                character,
                '\0' | '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
        })
    {
        return Err(SupportSortIpcProtocolError::InvalidData);
    }
    Ok(())
}

fn validate_https_url(value: &str) -> Result<(), SupportSortIpcProtocolError> {
    validate_text(value, MAX_POLICY_URL_BYTES)?;
    let Some(authority_and_path) = value.strip_prefix("https://") else {
        return Err(SupportSortIpcProtocolError::InvalidData);
    };
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    if authority.is_empty()
        || !authority.contains('.')
        || authority.contains('@')
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
        || !value.is_ascii()
    {
        return Err(SupportSortIpcProtocolError::InvalidData);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const SESSION: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const FINGERPRINT: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const DISCLOSURE: &str = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const TOKEN: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn submit_request() -> Value {
        json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "session_binding": SESSION,
            "command": {
                "kind": "submit",
                "authorization_token": TOKEN,
                "destination": "cloud_provider",
                "provider_key": "cloud-provider",
                "provider_fingerprint": FINGERPRINT,
                "disclosure_version": 1,
                "user_entered_text": "事实：需求临时改变。\n感受：有些烦。"
            }
        })
    }

    fn authorization_request() -> Value {
        json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "session_binding": SESSION,
            "command": {
                "kind": "issue_authorization",
                "destination": "cloud_provider",
                "provider_key": "cloud-provider",
                "provider_fingerprint": FINGERPRINT,
                "disclosure_version": 1,
                "disclosure_digest": DISCLOSURE,
                "user_confirmed": true
            }
        })
    }

    fn completed_response() -> Value {
        json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "result": {
                "kind": "sort_completed",
                "fact": "需求发生了变化",
                "feeling": "有些烦",
                "controllable": "可以确认范围",
                "next_step": "列出三个问题"
            }
        })
    }

    #[test]
    fn submit_round_trip_contains_only_authorization_binding_and_user_text() {
        let request = SupportSortIpcRequestV1::parse_and_validate(
            &serde_json::to_vec(&submit_request()).unwrap(),
        )
        .unwrap();
        let object: Value = serde_json::from_slice(&request.to_json().unwrap()).unwrap();
        let envelope_keys: Vec<_> = object
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            envelope_keys,
            vec![
                "command",
                "protocol_version",
                "request_id",
                "session_binding"
            ]
        );
        let command = object["command"].as_object().unwrap();
        let command_keys: Vec<_> = command.keys().map(String::as_str).collect();
        assert_eq!(
            command_keys,
            vec![
                "authorization_token",
                "destination",
                "disclosure_version",
                "kind",
                "provider_fingerprint",
                "provider_key",
                "user_entered_text"
            ]
        );
        for forbidden in [
            "task",
            "history",
            "memory",
            "workspace",
            "file",
            "clipboard",
        ] {
            assert!(object.get(forbidden).is_none());
            assert!(command.get(forbidden).is_none());
        }
    }

    #[test]
    fn request_and_result_sensitive_fields_are_explicitly_zeroized() {
        let mut request = SupportSortIpcRequestV1::parse_and_validate(
            &serde_json::to_vec(&submit_request()).unwrap(),
        )
        .unwrap();
        request.zeroize_sensitive();
        assert!(request.session_binding.is_empty());
        let SupportSortIpcCommandV1::Submit {
            authorization_token,
            provider_key,
            provider_fingerprint,
            user_entered_text,
            ..
        } = &request.command
        else {
            panic!("expected submit request")
        };
        assert!(authorization_token.is_empty());
        assert!(provider_key.is_empty());
        assert!(provider_fingerprint.is_empty());
        assert!(user_entered_text.is_empty());

        let mut response = SupportSortIpcResponseV1::parse_and_validate(
            &serde_json::to_vec(&completed_response()).unwrap(),
        )
        .unwrap();
        response.result.zeroize_sensitive();
        let SupportSortIpcResultV1::SortCompleted {
            fact,
            feeling,
            controllable,
            next_step,
        } = &response.result
        else {
            panic!("expected completed response")
        };
        assert!(fact.is_empty());
        assert!(feeling.is_empty());
        assert!(controllable.is_empty());
        assert!(next_step.is_empty());
    }

    #[test]
    fn unknown_context_fields_and_wrong_command_shapes_fail_closed() {
        for (field, value) in [
            ("task", json!("secret")),
            ("history", json!(["secret"])),
            ("workspace", json!("C:\\private")),
            ("provider_label", json!("untrusted override")),
        ] {
            let mut request = submit_request();
            request["command"][field] = value;
            assert!(SupportSortIpcRequestV1::parse_and_validate(
                &serde_json::to_vec(&request).unwrap()
            )
            .is_err());
        }
        let mut authorization = authorization_request();
        authorization["command"]["user_entered_text"] = json!("must not be collected yet");
        assert!(SupportSortIpcRequestV1::parse_and_validate(
            &serde_json::to_vec(&authorization).unwrap()
        )
        .is_err());
    }

    #[test]
    fn session_provider_disclosure_and_confirmation_are_mandatory() {
        let mut invalid = Vec::new();
        let mut wrong_session = authorization_request();
        wrong_session["session_binding"] = json!("not-a-binding");
        invalid.push(wrong_session);
        let mut wrong_fingerprint = authorization_request();
        wrong_fingerprint["command"]["provider_fingerprint"] = json!("unknown");
        invalid.push(wrong_fingerprint);
        let mut wrong_disclosure = authorization_request();
        wrong_disclosure["command"]["disclosure_digest"] = json!("unknown");
        invalid.push(wrong_disclosure);
        let mut unconfirmed = authorization_request();
        unconfirmed["command"]["user_confirmed"] = json!(false);
        invalid.push(unconfirmed);
        for request in invalid {
            assert!(SupportSortIpcRequestV1::parse_and_validate(
                &serde_json::to_vec(&request).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn text_size_nul_and_bidi_controls_fail_before_transport_use() {
        for text in ["", " \n\t", "contains\0nul", "contains\u{202e}bidi"] {
            let mut request = submit_request();
            request["command"]["user_entered_text"] = json!(text);
            assert!(SupportSortIpcRequestV1::parse_and_validate(
                &serde_json::to_vec(&request).unwrap()
            )
            .is_err());
        }
        let mut oversized = submit_request();
        oversized["command"]["user_entered_text"] =
            json!("猫".repeat(MAX_USER_ENTERED_TEXT_BYTES / 3 + 1));
        assert!(SupportSortIpcRequestV1::parse_and_validate(
            &serde_json::to_vec(&oversized).unwrap()
        )
        .is_err());
    }

    #[test]
    fn request_version_size_token_and_identifiers_are_bounded() {
        let mut wrong_version = submit_request();
        wrong_version["protocol_version"] = json!(2);
        assert!(matches!(
            SupportSortIpcRequestV1::parse_and_validate(
                &serde_json::to_vec(&wrong_version).unwrap()
            ),
            Err(SupportSortIpcProtocolError::UnsupportedVersion)
        ));
        for (field, value) in [
            ("authorization_token", json!("token")),
            ("request_id", json!("../request")),
            ("provider_key", json!("UPPERCASE")),
        ] {
            let mut request = submit_request();
            if field == "request_id" {
                request[field] = value;
            } else {
                request["command"][field] = value;
            }
            assert!(SupportSortIpcRequestV1::parse_and_validate(
                &serde_json::to_vec(&request).unwrap()
            )
            .is_err());
        }
        assert!(matches!(
            SupportSortIpcRequestV1::parse_and_validate(&vec![
                b'x';
                MAX_SUPPORT_SORT_IPC_REQUEST_BYTES
                    + 1
            ]),
            Err(SupportSortIpcProtocolError::InputTooLarge)
        ));
    }

    #[test]
    fn completed_response_exposes_only_the_four_tool_fields() {
        let response = SupportSortIpcResponseV1::parse_and_validate(
            &serde_json::to_vec(&completed_response()).unwrap(),
        )
        .unwrap();
        let object: Value = serde_json::from_slice(&response.to_json().unwrap()).unwrap();
        let envelope_keys: Vec<_> = object
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            envelope_keys,
            vec!["protocol_version", "request_id", "result"]
        );
        let result = object["result"].as_object().unwrap();
        let result_keys: Vec<_> = result.keys().map(String::as_str).collect();
        assert_eq!(
            result_keys,
            vec!["controllable", "fact", "feeling", "kind", "next_step",]
        );
        assert!(result.get("response_intent").is_none());
        assert!(result.get("display_document").is_none());
        assert!(result.get("action").is_none());
    }

    #[test]
    fn provider_description_requires_fixed_identity_disclosure_and_https_policy() {
        let valid = json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "result": {
                "kind": "provider_description",
                "destination": "cloud_provider",
                "provider_key": "cloud-provider",
                "provider_fingerprint": FINGERPRINT,
                "provider_label": "合成云服务",
                "disclosure_version": 1,
                "disclosure_digest": DISCLOSURE,
                "retention_summary": "合成说明，不代表真实服务。",
                "policy_url": "https://provider.invalid/privacy"
            }
        });
        assert!(
            SupportSortIpcResponseV1::parse_and_validate(&serde_json::to_vec(&valid).unwrap())
                .is_ok()
        );
        for url in [
            "http://provider.invalid",
            "https://user@provider.invalid",
            "javascript:x",
        ] {
            let mut response = valid.clone();
            response["result"]["policy_url"] = json!(url);
            assert!(SupportSortIpcResponseV1::parse_and_validate(
                &serde_json::to_vec(&response).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn output_fields_and_authorization_response_fail_closed_when_weakened() {
        let mut empty_field = completed_response();
        empty_field["result"]["feeling"] = json!("");
        assert!(SupportSortIpcResponseV1::parse_and_validate(
            &serde_json::to_vec(&empty_field).unwrap()
        )
        .is_err());

        let authorization = json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "result": {
                "kind": "authorization_issued",
                "authorization_token": TOKEN,
                "destination": "local_provider",
                "provider_key": "local-provider",
                "provider_fingerprint": FINGERPRINT,
                "disclosure_version": 1,
                "expires_at_unix_ms": 1_775_213_100_000_i64,
                "one_use": false
            }
        });
        assert!(SupportSortIpcResponseV1::parse_and_validate(
            &serde_json::to_vec(&authorization).unwrap()
        )
        .is_err());
    }
}
