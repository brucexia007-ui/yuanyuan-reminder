use std::path::PathBuf;

fn value(arguments: &[String], name: &str) -> Result<String, String> {
    let positions = arguments
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == name).then_some(index))
        .collect::<Vec<_>>();
    if positions.len() != 1 {
        return Err(format!("{name} must be provided exactly once"));
    }
    arguments
        .get(positions[0] + 1)
        .filter(|next| !next.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("{name} requires a value"))
}

fn require_attestation(arguments: &[String]) -> Result<(), String> {
    if arguments
        .iter()
        .filter(|argument| argument.as_str() == "--attest-windows-sandbox")
        .count()
        != 1
    {
        return Err("--attest-windows-sandbox is required exactly once".into());
    }
    Ok(())
}

fn parse_ids(value: &str) -> Result<Vec<String>, String> {
    let values = value.split(',').map(str::to_owned).collect::<Vec<_>>();
    if values.is_empty()
        || values.len() > 8
        || values
            .iter()
            .any(|item| uuid::Uuid::parse_str(item).is_err())
    {
        return Err("--reminder-ids must contain one to eight comma-separated UUIDs".into());
    }
    Ok(values)
}

fn run(arguments: &[String]) -> Result<String, String> {
    let mode = arguments
        .first()
        .ok_or_else(|| "mode is required".to_string())?;
    require_attestation(arguments)?;
    let root = PathBuf::from(value(arguments, "--data-root")?);
    let document = match mode.as_str() {
        "seed" => {
            let seconds = value(arguments, "--due-after-seconds")?
                .parse::<u64>()
                .map_err(|_| "--due-after-seconds must be an integer".to_string())?;
            serde_json::to_value(
                yuanyuan_reminder_lib::installed_candidate_qa::seed(&root, seconds)
                    .map_err(|error| error.to_string())?,
            )
        }
        "mutate" => serde_json::to_value(
            yuanyuan_reminder_lib::installed_candidate_qa::add_mutation(&root)
                .map_err(|error| error.to_string())?,
        ),
        "inspect" => {
            let ids = parse_ids(&value(arguments, "--reminder-ids")?)?;
            serde_json::to_value(
                yuanyuan_reminder_lib::installed_candidate_qa::inspect(&root, &ids)
                    .map_err(|error| error.to_string())?,
            )
        }
        _ => return Err("mode must be seed, mutate, or inspect".into()),
    }
    .map_err(|error| error.to_string())?;
    serde_json::to_string(&document).map_err(|error| error.to_string())
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match run(&arguments) {
        Ok(document) => println!("{document}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_attestation_and_malformed_ids_before_touching_data() {
        let root = [
            "C:",
            "Users",
            "WDAGUtilityAccount",
            "AppData",
            "Local",
            "com.yuanyuan.reminder",
        ]
        .join(r"\");
        assert!(run(&[
            "inspect".into(),
            "--data-root".into(),
            root.clone(),
            "--reminder-ids".into(),
            uuid::Uuid::new_v4().to_string(),
        ])
        .unwrap_err()
        .contains("attest"));
        assert!(run(&[
            "inspect".into(),
            "--data-root".into(),
            root,
            "--reminder-ids".into(),
            "not-an-id".into(),
            "--attest-windows-sandbox".into(),
        ])
        .unwrap_err()
        .contains("UUID"));
    }
}
