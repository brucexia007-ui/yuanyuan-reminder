const PROVIDER_SOURCE: &str = include_str!("provider.rs");
const AI_MAIN_SOURCE: &str = include_str!("main.rs");
const CRASH_PRIVACY_SOURCE: &str = include_str!("crash_privacy.rs");
const PIPE_SERVER_SOURCE: &str =
    include_str!("../../yuanyuan-bridge/src/windows_named_pipe_server.rs");
const AUTHORIZATION_SOURCE: &str = include_str!("support_sort_authorization.rs");
const SUPPORT_PROVIDER_SOURCE: &str = include_str!("support_sort_provider.rs");
const SEMANTIC_GATE_SOURCE: &str = include_str!("support_sort_semantic_gate.rs");
const HOST_SOURCE: &str = include_str!("support_sort_host.rs");
const BOOTSTRAP_SOURCE: &str = include_str!("support_sort_bootstrap.rs");
const IPC_SOURCE: &str = include_str!("../../yuanyuan-protocol/src/support_sort_ipc.rs");
const SUPERVISOR_SOURCE: &str = include_str!("../../../src/ai_supervisor.rs");
const PANEL_GATE_SOURCE: &str = include_str!("../../../src/support_sort_panel_gate.rs");

fn production_source(source: &str) -> &str {
    let test_markers = [
        "#[cfg(test)]\nmod tests",
        "#[cfg(all(test, windows))]\nmod tests",
    ];
    let boundary = test_markers
        .iter()
        .filter_map(|marker| source.find(marker))
        .min()
        .unwrap_or(source.len());
    &source[..boundary]
}

fn declaration_prelude<'a>(source: &'a str, declaration: &str) -> &'a str {
    let declaration_at = source
        .find(declaration)
        .unwrap_or_else(|| panic!("missing sensitive declaration: {declaration}"));
    let prefix = &source[..declaration_at];
    let item_at = prefix.rfind("\n\n").map_or(0, |index| index + 2);
    &source[item_at..declaration_at]
}

#[test]
fn support_sort_production_path_has_no_text_logging_sink() {
    for (name, source) in [
        ("provider", PROVIDER_SOURCE),
        ("AI process main", AI_MAIN_SOURCE),
        ("AI crash privacy policy", CRASH_PRIVACY_SOURCE),
        ("pre-read pipe guard", PIPE_SERVER_SOURCE),
        ("authorization", AUTHORIZATION_SOURCE),
        ("support provider", SUPPORT_PROVIDER_SOURCE),
        ("support semantic gate", SEMANTIC_GATE_SOURCE),
        ("host", HOST_SOURCE),
        ("bootstrap", BOOTSTRAP_SOURCE),
        ("IPC", IPC_SOURCE),
        ("stable-core supervisor", SUPERVISOR_SOURCE),
        ("unregistered panel gate", PANEL_GATE_SOURCE),
    ] {
        let production = production_source(source);
        for forbidden in ["tracing::", "log::", "println!", "eprintln!", "dbg!"] {
            assert!(
                !production.contains(forbidden),
                "{name} introduced a forbidden output sink: {forbidden}"
            );
        }
    }
}

#[test]
fn sensitive_payload_types_never_derive_automatic_debug() {
    for (source, declaration) in [
        (PROVIDER_SOURCE, "pub struct ProviderRequest"),
        (PROVIDER_SOURCE, "pub struct ProviderFinal"),
        (PROVIDER_SOURCE, "pub enum ProviderEvent"),
        (PROVIDER_SOURCE, "pub struct ProviderOutcome"),
        (
            AUTHORIZATION_SOURCE,
            "pub struct SupportSortAuthorizationCapability",
        ),
        (AUTHORIZATION_SOURCE, "pub struct AuthorizedSupportSortCall"),
        (SUPPORT_PROVIDER_SOURCE, "pub struct SupportSortOutcome"),
        (IPC_SOURCE, "pub struct SupportSortIpcRequestV1"),
        (IPC_SOURCE, "pub enum SupportSortIpcCommandV1"),
        (IPC_SOURCE, "pub struct SupportSortIpcResponseV1"),
        (IPC_SOURCE, "pub enum SupportSortIpcResultV1"),
        (PANEL_GATE_SOURCE, "pub(crate) enum SupportSortPanelCommand"),
    ] {
        let prelude = declaration_prelude(production_source(source), declaration);
        assert!(
            !prelude.contains("Debug"),
            "{declaration} must not derive automatic Debug"
        );
    }
}

#[test]
fn sensitive_owners_keep_explicit_zeroization_paths() {
    for (source, marker) in [
        (PROVIDER_SOURCE, "impl Drop for ProviderRequest"),
        (PROVIDER_SOURCE, "impl Drop for ProviderFinal"),
        (
            AUTHORIZATION_SOURCE,
            "impl Drop for SupportSortAuthorizationCapability",
        ),
        (
            AUTHORIZATION_SOURCE,
            "impl Drop for AuthorizedSupportSortCall",
        ),
        (
            AUTHORIZATION_SOURCE,
            "impl Drop for SupportSortAuthorizationGate",
        ),
        (SUPPORT_PROVIDER_SOURCE, "impl Drop for SupportSortOutcome"),
        (
            SUPPORT_PROVIDER_SOURCE,
            "impl Drop for SensitiveSupportSortDocument",
        ),
        (IPC_SOURCE, "impl Drop for SupportSortIpcRequestV1"),
        (IPC_SOURCE, "impl Drop for SupportSortIpcCommandV1"),
        (IPC_SOURCE, "impl Drop for SupportSortIpcResultV1"),
        (PANEL_GATE_SOURCE, "impl Drop for SupportSortPanelCommand"),
    ] {
        assert!(
            production_source(source).contains(marker),
            "missing sensitive cleanup contract: {marker}"
        );
    }
}
