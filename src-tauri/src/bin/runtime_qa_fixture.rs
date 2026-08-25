#[cfg(windows)]
fn main() {
    use std::path::PathBuf;

    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() != Some("--root") {
        std::process::exit(2);
    }
    let Some(root) = arguments.next().map(PathBuf::from) else {
        std::process::exit(2);
    };
    let Some(mode) = arguments.next() else {
        std::process::exit(2);
    };
    let value = arguments.next();
    if arguments.next().is_some() {
        std::process::exit(2);
    }

    let root = yuanyuan_reminder_lib::runtime_qa::create_root(&root)
        .unwrap_or_else(|_| std::process::exit(3));
    std::env::set_var("YUANYUAN_RUNTIME_QA_ROOT", &root);

    let result = match mode.as_str() {
        "--prepare-only" if value.is_none() => return,
        "--reminder-latency" => value
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(())
            .and_then(|seconds| {
                yuanyuan_reminder_lib::runtime_qa::seed_reminder_latency(seconds).map_err(|_| ())
            })
            .and_then(|plan| serde_json::to_string(&plan).map_err(|_| ())),
        "--read-reminder-latency" => value
            .ok_or(())
            .and_then(|reminder_id| {
                yuanyuan_reminder_lib::runtime_qa::read_reminder_latency_claim(&reminder_id)
                    .map_err(|_| ())
            })
            .and_then(|claim| serde_json::to_string(&claim).map_err(|_| ())),
        #[cfg(feature = "learning")]
        "--learning-performance" => value
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(())
            .and_then(|card_count| {
                yuanyuan_reminder_lib::runtime_qa::seed_learning_performance(card_count)
                    .map_err(|_| ())
            })
            .and_then(|plan| serde_json::to_string(&plan).map_err(|_| ())),
        "--animation-mode" => value
            .ok_or(())
            .and_then(|animation_mode| {
                yuanyuan_reminder_lib::runtime_qa::seed_animation_mode(&animation_mode)
                    .map_err(|_| ())
            })
            .map(|()| String::from("{\"updated\":true}")),
        #[cfg(feature = "learning")]
        "--learning-recovery-state" if value.is_none() => {
            yuanyuan_reminder_lib::runtime_qa::read_learning_recovery_state()
                .map_err(|_| ())
                .and_then(|state| serde_json::to_string(&state).map_err(|_| ()))
        }
        #[cfg(feature = "learning")]
        "--learning-preemption" => value
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(())
            .and_then(|seconds| {
                yuanyuan_reminder_lib::runtime_qa::seed_learning_preemption(seconds).map_err(|_| ())
            })
            .and_then(|plan| serde_json::to_string(&plan).map_err(|_| ())),
        #[cfg(feature = "learning")]
        "--learning-preemption-state" if value.is_none() => {
            yuanyuan_reminder_lib::runtime_qa::read_learning_preemption_state()
                .map_err(|_| ())
                .and_then(|state| serde_json::to_string(&state).map_err(|_| ()))
        }
        _ => Err(()),
    };
    match result {
        Ok(json) => println!("{json}"),
        Err(()) => std::process::exit(4),
    }
}

#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
