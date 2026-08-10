use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use yuanyuan_bridge::{NamedPipeEventSink, WindowsProcessIdentity};

const SUPPORT_SORT_BOOTSTRAP_SCHEMA_VERSION: u16 = 1;
const MAX_SUPPORT_SORT_BOOTSTRAP_BYTES: usize = 1_024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SupportSortBootstrapWireV1 {
    schema_version: u16,
    session_binding: String,
    support_pipe_name: String,
    expected_client_process_id: u32,
    expected_client_creation_time_100ns: u64,
}

impl Drop for SupportSortBootstrapWireV1 {
    fn drop(&mut self) {
        self.session_binding.zeroize();
        self.support_pipe_name.zeroize();
    }
}

/// Sensitive one-process bootstrap delivered through inherited stdin. This
/// type intentionally has no Debug, Clone, Serialize or Deserialize surface.
/// Its session binding is zeroized when the AI process exits or initialization
/// fails after parsing.
pub struct SupportSortSessionBootstrap {
    session_binding: String,
    support_pipe_name: String,
    expected_client: WindowsProcessIdentity,
}

impl Drop for SupportSortSessionBootstrap {
    fn drop(&mut self) {
        self.session_binding.zeroize();
        self.support_pipe_name.zeroize();
    }
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum SupportSortBootstrapError {
    #[error("support sort bootstrap random generation failed")]
    Random,
    #[error("support sort bootstrap I/O failed")]
    Io,
    #[error("support sort bootstrap is too large")]
    InputTooLarge,
    #[error("support sort bootstrap is invalid")]
    Invalid,
}

impl SupportSortSessionBootstrap {
    pub fn generate(
        expected_client: WindowsProcessIdentity,
    ) -> Result<Self, SupportSortBootstrapError> {
        if expected_client.process_id == 0 || expected_client.creation_time_100ns == 0 {
            return Err(SupportSortBootstrapError::Invalid);
        }
        let mut random = Zeroizing::new([0_u8; 32]);
        getrandom::fill(&mut random[..]).map_err(|_| SupportSortBootstrapError::Random)?;
        let session_binding = random
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        let support_pipe_name = format!("yuanyuan.support-sort.v1.{}", Uuid::new_v4());
        let bootstrap = Self {
            session_binding,
            support_pipe_name,
            expected_client,
        };
        bootstrap.validate()?;
        Ok(bootstrap)
    }

    pub fn read_from<R: Read>(mut reader: R) -> Result<Self, SupportSortBootstrapError> {
        let mut input = Zeroizing::new(Vec::with_capacity(MAX_SUPPORT_SORT_BOOTSTRAP_BYTES));
        reader
            .by_ref()
            .take((MAX_SUPPORT_SORT_BOOTSTRAP_BYTES + 1) as u64)
            .read_to_end(&mut input)
            .map_err(|_| SupportSortBootstrapError::Io)?;
        if input.len() > MAX_SUPPORT_SORT_BOOTSTRAP_BYTES {
            return Err(SupportSortBootstrapError::InputTooLarge);
        }
        let mut wire: SupportSortBootstrapWireV1 =
            serde_json::from_slice(&input).map_err(|_| SupportSortBootstrapError::Invalid)?;
        if wire.schema_version != SUPPORT_SORT_BOOTSTRAP_SCHEMA_VERSION {
            return Err(SupportSortBootstrapError::Invalid);
        }
        let bootstrap = Self {
            session_binding: std::mem::take(&mut wire.session_binding),
            support_pipe_name: std::mem::take(&mut wire.support_pipe_name),
            expected_client: WindowsProcessIdentity {
                process_id: wire.expected_client_process_id,
                creation_time_100ns: wire.expected_client_creation_time_100ns,
            },
        };
        bootstrap.validate()?;
        Ok(bootstrap)
    }

    pub fn write_to<W: Write>(&self, mut writer: W) -> Result<(), SupportSortBootstrapError> {
        let encoded = self.to_bytes()?;
        writer
            .write_all(&encoded)
            .map_err(|_| SupportSortBootstrapError::Io)
    }

    pub fn session_binding(&self) -> &str {
        &self.session_binding
    }

    pub fn support_pipe_name(&self) -> &str {
        &self.support_pipe_name
    }

    pub fn expected_client(&self) -> WindowsProcessIdentity {
        self.expected_client
    }

    /// AI-side replay defense: the stable core identity embedded in the
    /// private bootstrap must be the process that directly created this AI
    /// process, including creation time to close PID-reuse ambiguity.
    pub fn validate_current_parent(&self) -> Result<(), SupportSortBootstrapError> {
        let parent = yuanyuan_bridge::current_parent_process_identity()
            .map_err(|_| SupportSortBootstrapError::Invalid)?;
        if parent != self.expected_client {
            return Err(SupportSortBootstrapError::Invalid);
        }
        Ok(())
    }

    fn to_bytes(&self) -> Result<Zeroizing<Vec<u8>>, SupportSortBootstrapError> {
        self.validate()?;
        let wire = SupportSortBootstrapWireV1 {
            schema_version: SUPPORT_SORT_BOOTSTRAP_SCHEMA_VERSION,
            session_binding: self.session_binding.clone(),
            support_pipe_name: self.support_pipe_name.clone(),
            expected_client_process_id: self.expected_client.process_id,
            expected_client_creation_time_100ns: self.expected_client.creation_time_100ns,
        };
        let mut encoded = Zeroizing::new(
            serde_json::to_vec(&wire).map_err(|_| SupportSortBootstrapError::Invalid)?,
        );
        if encoded.len() > MAX_SUPPORT_SORT_BOOTSTRAP_BYTES {
            encoded.zeroize();
            return Err(SupportSortBootstrapError::InputTooLarge);
        }
        Ok(encoded)
    }

    fn validate(&self) -> Result<(), SupportSortBootstrapError> {
        if self.session_binding.len() != 64
            || !self
                .session_binding
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
            || self.expected_client.process_id == 0
            || self.expected_client.creation_time_100ns == 0
            || NamedPipeEventSink::new(&self.support_pipe_name).is_err()
        {
            return Err(SupportSortBootstrapError::Invalid);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yuanyuan_bridge::current_process_identity;

    #[test]
    fn generated_bootstrap_is_random_private_and_round_trips_through_bytes() {
        let expected = current_process_identity().unwrap();
        let first = SupportSortSessionBootstrap::generate(expected).unwrap();
        let second = SupportSortSessionBootstrap::generate(expected).unwrap();
        assert_ne!(first.session_binding(), second.session_binding());
        assert_ne!(first.support_pipe_name(), second.support_pipe_name());
        assert_eq!(first.session_binding().len(), 64);

        let mut bytes = Vec::new();
        first.write_to(&mut bytes).unwrap();
        let parsed = SupportSortSessionBootstrap::read_from(bytes.as_slice()).unwrap();
        assert_eq!(parsed.session_binding(), first.session_binding());
        assert_eq!(parsed.support_pipe_name(), first.support_pipe_name());
        assert_eq!(parsed.expected_client(), expected);
    }

    #[test]
    fn malformed_unknown_and_oversized_bootstraps_fail_closed() {
        let invalid = [
            br#"{}"#.as_slice(),
            br#"{"schema_version":1,"unknown":true}"#.as_slice(),
            br#"{"schema_version":2,"session_binding":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","support_pipe_name":"yuanyuan.support-sort.v1.test","expected_client_process_id":1,"expected_client_creation_time_100ns":1}"#.as_slice(),
        ];
        for input in invalid {
            assert!(matches!(
                SupportSortSessionBootstrap::read_from(input),
                Err(SupportSortBootstrapError::Invalid)
            ));
        }
        assert!(matches!(
            SupportSortSessionBootstrap::read_from(
                &vec![b'x'; MAX_SUPPORT_SORT_BOOTSTRAP_BYTES + 1][..]
            ),
            Err(SupportSortBootstrapError::InputTooLarge)
        ));
    }

    #[test]
    fn invalid_expected_client_identity_is_rejected_before_random_generation() {
        assert!(matches!(
            SupportSortSessionBootstrap::generate(WindowsProcessIdentity {
                process_id: 0,
                creation_time_100ns: 0,
            }),
            Err(SupportSortBootstrapError::Invalid)
        ));
    }
}
