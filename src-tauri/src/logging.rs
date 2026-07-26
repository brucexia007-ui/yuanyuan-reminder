use std::{fs, path::Path};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, EnvFilter};

use crate::error::AppResult;

pub fn init(log_dir: &Path) -> AppResult<WorkerGuard> {
    fs::create_dir_all(log_dir)?;
    let appender = tracing_appender::rolling::daily(log_dir, "yuanyuan-reminder.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let subscriber = fmt()
        .with_env_filter(EnvFilter::new("info"))
        .with_ansi(false)
        .with_target(true)
        .with_writer(writer)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
    Ok(guard)
}
