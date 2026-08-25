use std::{fs, path::PathBuf};

use serde::Deserialize;
use yuanyuan_learning_pack_spike::{
    parse_csv, parse_json, validate_declared_sha256, ErrorCode, MAX_PACKAGE_BYTES,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    declared_sha256: Option<String>,
    target_bytes: Option<usize>,
    target_cards: Option<usize>,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/learning-content-security")
}

fn read(name: &str) -> Vec<u8> {
    fs::read(fixtures().join(name)).unwrap()
}

#[test]
fn sec_fix_001_accepts_the_frozen_minimal_package() {
    let parsed = parse_json(&read("valid-minimal.json")).unwrap();
    assert_eq!(parsed.cards.len(), 1);
    assert_eq!(parsed.pack_id, "synthetic.security.valid");
}

#[test]
fn sec_fix_002_rejects_a_declared_identity_mismatch() {
    let descriptor: Descriptor =
        serde_json::from_slice(&read("identity-mismatch-descriptor.json")).unwrap();
    let error = validate_declared_sha256(
        &read("valid-minimal.json"),
        descriptor.declared_sha256.as_deref().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
}

#[test]
fn sec_fix_003_through_010_fail_closed_in_the_real_parser() {
    let cases = [
        ("unknown-field.json", ErrorCode::UnknownField),
        ("unicode-bidi.json", ErrorCode::UnicodeControl),
        ("path-traversal.json", ErrorCode::UnknownField),
        ("external-resource.json", ErrorCode::UnknownField),
        ("duplicate-card-ids.json", ErrorCode::DuplicateIdentifier),
        ("deeply-nested.json", ErrorCode::JsonDepth),
        ("malformed.json", ErrorCode::MalformedJson),
    ];
    for (name, expected) in cases {
        assert_eq!(
            parse_json(&read(name)).unwrap_err().code,
            expected,
            "{name}"
        );
    }
    assert_eq!(
        parse_csv(
            &read("formula-injection.csv"),
            "synthetic.security.formula",
            "Formula fixture"
        )
        .unwrap_err()
        .code,
        ErrorCode::FormulaPrefix
    );
}

#[test]
fn sec_fix_011_rejects_both_frozen_size_and_card_budgets() {
    let descriptor: Descriptor =
        serde_json::from_slice(&read("oversized-descriptor.json")).unwrap();
    let oversized = vec![b' '; descriptor.target_bytes.unwrap()];
    assert_eq!(
        parse_json(&oversized).unwrap_err().code,
        ErrorCode::ByteBudget
    );
    assert_eq!(oversized.len(), MAX_PACKAGE_BYTES + 1);

    let count = descriptor.target_cards.unwrap();
    let mut json = String::from(
        "{\"schemaVersion\":1,\"packId\":\"synthetic.too-many\",\"title\":\"Too many\",\"cards\":[",
    );
    for index in 0..count {
        if index > 0 {
            json.push(',');
        }
        json.push_str(&format!(
            "{{\"id\":\"c{index}\",\"front\":\"p\",\"back\":\"a\"}}"
        ));
    }
    json.push_str("]}");
    assert!(json.len() < MAX_PACKAGE_BYTES);
    assert_eq!(
        parse_json(json.as_bytes()).unwrap_err().code,
        ErrorCode::CardBudget
    );
}

#[test]
fn sec_fix_012_and_013_remain_explicitly_outside_the_pure_parser_spike() {
    for name in [
        "preview-token-replay-descriptor.json",
        "half-install-descriptor.json",
    ] {
        assert_eq!(
            parse_json(&read(name)).unwrap_err().code,
            ErrorCode::UnknownField
        );
    }
}
