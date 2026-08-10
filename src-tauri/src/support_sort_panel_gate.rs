use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;
use yuanyuan_protocol::{
    SupportSortIpcCommandV1, SupportSortIpcDestination, SupportSortIpcResponseV1,
};
use zeroize::Zeroize;

use crate::ai_supervisor::AiSupervisor;

const SUPPORT_SORT_PANEL_WINDOW_LABEL: &str = "panel";

#[derive(Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SupportSortPanelCommand {
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

impl SupportSortPanelCommand {
    fn into_ipc(mut self) -> SupportSortIpcCommandV1 {
        match &mut self {
            Self::DescribeProvider { destination } => SupportSortIpcCommandV1::DescribeProvider {
                destination: *destination,
            },
            Self::IssueAuthorization {
                destination,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                disclosure_digest,
                user_confirmed,
            } => SupportSortIpcCommandV1::IssueAuthorization {
                destination: *destination,
                provider_key: std::mem::take(provider_key),
                provider_fingerprint: std::mem::take(provider_fingerprint),
                disclosure_version: *disclosure_version,
                disclosure_digest: std::mem::take(disclosure_digest),
                user_confirmed: *user_confirmed,
            },
            Self::Submit {
                authorization_token,
                destination,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                user_entered_text,
            } => SupportSortIpcCommandV1::Submit {
                authorization_token: std::mem::take(authorization_token),
                destination: *destination,
                provider_key: std::mem::take(provider_key),
                provider_fingerprint: std::mem::take(provider_fingerprint),
                disclosure_version: *disclosure_version,
                user_entered_text: std::mem::take(user_entered_text),
            },
            Self::Cancel {
                authorization_token,
            } => SupportSortIpcCommandV1::Cancel {
                authorization_token: std::mem::take(authorization_token),
            },
            Self::RevokeAll => SupportSortIpcCommandV1::RevokeAll,
        }
    }

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

impl Drop for SupportSortPanelCommand {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum SupportSortPanelDispatchError {
    #[error("support sort is available only from the task panel")]
    WrongWindow,
    #[error("support sort service is unavailable")]
    Unavailable,
}

pub(crate) fn dispatch_support_sort_panel_command(
    window_label: &str,
    supervisor: &AiSupervisor,
    command: SupportSortPanelCommand,
) -> Result<SupportSortIpcResponseV1, SupportSortPanelDispatchError> {
    if window_label != SUPPORT_SORT_PANEL_WINDOW_LABEL {
        return Err(SupportSortPanelDispatchError::WrongWindow);
    }
    supervisor
        .request_support_sort(
            format!("support-panel-{}", Uuid::new_v4()),
            command.into_ipc(),
        )
        .map_err(|_| SupportSortPanelDispatchError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yuanyuan_ai::{SupportSortService, SupportSortSessionBootstrap};
    use yuanyuan_bridge::current_process_identity;
    use yuanyuan_protocol::{
        SupportSortIpcRejectionCode, SupportSortIpcResultV1, SUPPORT_SORT_IPC_PROTOCOL_VERSION,
    };

    #[test]
    fn panel_schema_has_no_request_id_session_or_extra_context_entry() {
        let valid = serde_json::json!({
            "kind": "submit",
            "authorization_token": "123e4567-e89b-12d3-a456-426614174000",
            "destination": "local_provider",
            "provider_key": "local-provider",
            "provider_fingerprint": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "disclosure_version": 1,
            "user_entered_text": "只发送这一段"
        });
        assert!(serde_json::from_value::<SupportSortPanelCommand>(valid.clone()).is_ok());
        for forbidden in ["request_id", "session_binding", "workspace", "history"] {
            let mut invalid = valid.clone();
            invalid[forbidden] = serde_json::json!("forbidden");
            assert!(serde_json::from_value::<SupportSortPanelCommand>(invalid).is_err());
        }
    }

    #[test]
    fn non_panel_window_is_rejected_before_an_unavailable_supervisor_is_touched() {
        let supervisor = AiSupervisor::start(None);
        let result = dispatch_support_sort_panel_command(
            "pet",
            &supervisor,
            SupportSortPanelCommand::Submit {
                authorization_token: "123e4567-e89b-12d3-a456-426614174000".to_owned(),
                destination: SupportSortIpcDestination::LocalProvider,
                provider_key: "local-provider".to_owned(),
                provider_fingerprint:
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
                disclosure_version: 1,
                user_entered_text: "不得进入服务".to_owned(),
            },
        );
        assert!(matches!(
            result,
            Err(SupportSortPanelDispatchError::WrongWindow)
        ));
        supervisor.shutdown();
    }

    #[test]
    fn panel_dispatch_generates_the_request_id_and_injects_the_private_session() {
        let generated =
            SupportSortSessionBootstrap::generate(current_process_identity().unwrap()).unwrap();
        let mut encoded = Vec::new();
        generated.write_to(&mut encoded).unwrap();
        let service_bootstrap = SupportSortSessionBootstrap::read_from(encoded.as_slice()).unwrap();
        let supervisor_bootstrap =
            SupportSortSessionBootstrap::read_from(encoded.as_slice()).unwrap();
        encoded.fill(0);
        let service = SupportSortService::start(
            service_bootstrap,
            yuanyuan_ai::SupportSortProviderRegistry::default(),
            || 1_775_212_800_000,
        )
        .unwrap();
        let supervisor = AiSupervisor::start(None);
        assert!(supervisor.install_running_test_support_session(supervisor_bootstrap));

        let response = dispatch_support_sort_panel_command(
            "panel",
            &supervisor,
            SupportSortPanelCommand::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            },
        )
        .unwrap();
        assert_eq!(response.protocol_version, SUPPORT_SORT_IPC_PROTOCOL_VERSION);
        assert!(response.request_id.starts_with("support-panel-"));
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::ProviderUnavailable
            }
        ));

        supervisor.shutdown();
        service.shutdown();
    }
}
