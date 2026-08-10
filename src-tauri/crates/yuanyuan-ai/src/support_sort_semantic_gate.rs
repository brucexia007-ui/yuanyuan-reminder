use zeroize::Zeroizing;

const MAX_FACT_BYTES: usize = 512;
const MAX_FEELING_BYTES: usize = 256;
const MAX_CONTROLLABLE_BYTES: usize = 512;
const MAX_NEXT_STEP_BYTES: usize = 512;
const MAX_TOTAL_BYTES: usize = 1_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupportSortSemanticRejection {
    InvalidShape,
    CatDialogue,
    Diagnosis,
    MotiveAttribution,
    Coercion,
    DependencyOrGuilt,
    FalseReassurance,
    ProductivityPressure,
    StructuralMinimization,
    CrisisOrMedicalHandling,
    UnsafeContent,
}

#[derive(Clone, Copy)]
enum SupportSortField {
    Fact,
    Feeling,
    Controllable,
    NextStep,
}

const CAT_DIALOGUE_PATTERNS: &[&str] = &[
    "圆圆说",
    "圆圆觉得",
    "圆圆懂你",
    "圆圆陪你",
    "圆圆会一直",
    "本喵",
    "我是一只猫",
    "主人",
    "铲屎官",
    "喵~",
    "喵～",
    "我会一直陪你",
    "让我陪着你",
];

const DIAGNOSIS_PATTERNS: &[&str] = &[
    "你患有",
    "你得了",
    "你这是焦虑",
    "你这是抑郁",
    "你有焦虑症",
    "你有抑郁症",
    "说明你有心理",
    "证明你有心理",
    "人格障碍",
    "心理疾病",
    "精神疾病",
    "创伤后应激",
    "双相情感",
    "注意缺陷多动",
    "职业倦怠症",
];

const MOTIVE_ATTRIBUTION_PATTERNS: &[&str] = &[
    "他就是故意",
    "她就是故意",
    "对方就是故意",
    "他们就是故意",
    "他嫉妒你",
    "她嫉妒你",
    "对方嫉妒你",
    "想控制你",
    "故意打压你",
    "根本不尊重你",
    "就是针对你",
    "人品有问题",
];

const DEPENDENCY_OR_GUILT_PATTERNS: &[&str] = &[
    "只有圆圆",
    "离不开圆圆",
    "别离开我",
    "不要离开我",
    "圆圆会难过",
    "圆圆很孤单",
    "圆圆需要你",
    "必须回应圆圆",
    "每天都要来",
    "连续陪伴打卡",
];

const FALSE_REASSURANCE_PATTERNS: &[&str] = &[
    "一定会没事",
    "肯定能解决",
    "保证能解决",
    "保证会成功",
    "绝对没问题",
    "一切都会好起来",
    "不用担心",
];

const PRODUCTIVITY_PRESSURE_PATTERNS: &[&str] = &[
    "尽快恢复工作",
    "赶快恢复工作",
    "休息是为了提高效率",
    "休息后效率会更高",
    "调整好继续干",
    "情绪已完成",
    "完成安抚",
    "不要耽误工作",
];

const STRUCTURAL_MINIMIZATION_PATTERNS: &[&str] = &[
    "都是你的问题",
    "只是你想太多",
    "你太敏感",
    "别想太多",
    "想开一点",
    "调整心态就好",
    "改变自己就好",
    "不要抱怨",
    "学会适应就好",
];

const CRISIS_OR_MEDICAL_PATTERNS: &[&str] = &[
    "自杀",
    "自残",
    "伤害自己",
    "伤害他人",
    "杀了他",
    "杀了她",
    "危机热线",
    "心理热线",
    "急救电话",
    "紧急服务",
    "拨打110",
    "拨打120",
    "报警处理",
    "前往急诊",
    "药物剂量",
    "增加剂量",
    "减少剂量",
    "停止服药",
    "处方药",
];

const UNSAFE_CONTENT_PATTERNS: &[&str] = &[
    "http//",
    "https//",
    "javascript",
    "datatexthtml",
    "file//",
    "cmdexe",
    "powershell",
];

const COERCION_PATTERNS: &[&str] = &[
    "你必须",
    "你应该马上",
    "务必",
    "赶紧",
    "立刻继续",
    "马上继续",
    "振作起来",
    "不要浪费时间",
    "不能停下来",
    "现在就去",
];

pub(crate) fn validate_support_sort_semantics(
    fact: &str,
    feeling: &str,
    controllable: &str,
    next_step: &str,
) -> Result<(), SupportSortSemanticRejection> {
    let fields = [
        (SupportSortField::Fact, fact, MAX_FACT_BYTES),
        (SupportSortField::Feeling, feeling, MAX_FEELING_BYTES),
        (
            SupportSortField::Controllable,
            controllable,
            MAX_CONTROLLABLE_BYTES,
        ),
        (SupportSortField::NextStep, next_step, MAX_NEXT_STEP_BYTES),
    ];
    let total = fields
        .iter()
        .try_fold(0_usize, |total, (_, value, limit)| {
            if value.trim().is_empty()
                || value.len() > *limit
                || value.contains(['\r', '\n', '\t'])
                || value.chars().any(is_forbidden_control)
            {
                return Err(SupportSortSemanticRejection::InvalidShape);
            }
            total
                .checked_add(value.len())
                .ok_or(SupportSortSemanticRejection::InvalidShape)
        })?;
    if total > MAX_TOTAL_BYTES {
        return Err(SupportSortSemanticRejection::InvalidShape);
    }

    for (field, value, _) in fields {
        let normalized = Zeroizing::new(normalize_for_fixed_rules(value));
        reject_patterns(
            &normalized,
            CAT_DIALOGUE_PATTERNS,
            SupportSortSemanticRejection::CatDialogue,
        )?;
        reject_patterns(
            &normalized,
            DIAGNOSIS_PATTERNS,
            SupportSortSemanticRejection::Diagnosis,
        )?;
        reject_patterns(
            &normalized,
            MOTIVE_ATTRIBUTION_PATTERNS,
            SupportSortSemanticRejection::MotiveAttribution,
        )?;
        reject_patterns(
            &normalized,
            DEPENDENCY_OR_GUILT_PATTERNS,
            SupportSortSemanticRejection::DependencyOrGuilt,
        )?;
        reject_patterns(
            &normalized,
            FALSE_REASSURANCE_PATTERNS,
            SupportSortSemanticRejection::FalseReassurance,
        )?;
        reject_patterns(
            &normalized,
            PRODUCTIVITY_PRESSURE_PATTERNS,
            SupportSortSemanticRejection::ProductivityPressure,
        )?;
        reject_patterns(
            &normalized,
            STRUCTURAL_MINIMIZATION_PATTERNS,
            SupportSortSemanticRejection::StructuralMinimization,
        )?;
        reject_patterns(
            &normalized,
            CRISIS_OR_MEDICAL_PATTERNS,
            SupportSortSemanticRejection::CrisisOrMedicalHandling,
        )?;
        reject_patterns(
            &normalized,
            UNSAFE_CONTENT_PATTERNS,
            SupportSortSemanticRejection::UnsafeContent,
        )?;
        if matches!(
            field,
            SupportSortField::Controllable | SupportSortField::NextStep
        ) {
            reject_patterns(
                &normalized,
                COERCION_PATTERNS,
                SupportSortSemanticRejection::Coercion,
            )?;
        }
    }
    Ok(())
}

fn reject_patterns(
    normalized: &str,
    patterns: &[&str],
    rejection: SupportSortSemanticRejection,
) -> Result<(), SupportSortSemanticRejection> {
    if patterns.iter().any(|pattern| normalized.contains(pattern)) {
        Err(rejection)
    } else {
        Ok(())
    }
}

fn normalize_for_fixed_rules(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(
                    character,
                    '，' | '。'
                        | '！'
                        | '？'
                        | '、'
                        | '：'
                        | '；'
                        | ','
                        | '.'
                        | '!'
                        | '?'
                        | ':'
                        | ';'
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '"'
                        | '\''
                )
        })
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_forbidden_control(character: char) -> bool {
    matches!(
        character,
        '\0' | '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct SemanticFixture {
        schema_version: u16,
        purpose: String,
        accepted: Vec<SemanticCase>,
        rejected: Vec<RejectedSemanticCase>,
    }

    #[derive(Deserialize)]
    struct SemanticCase {
        case_id: String,
        fact: String,
        feeling: String,
        controllable: String,
        next_step: String,
    }

    #[derive(Deserialize)]
    struct RejectedSemanticCase {
        case_id: String,
        expected: String,
        fact: String,
        feeling: String,
        controllable: String,
        next_step: String,
    }

    fn rejection_code(rejection: SupportSortSemanticRejection) -> &'static str {
        match rejection {
            SupportSortSemanticRejection::InvalidShape => "invalid_shape",
            SupportSortSemanticRejection::CatDialogue => "cat_dialogue",
            SupportSortSemanticRejection::Diagnosis => "diagnosis",
            SupportSortSemanticRejection::MotiveAttribution => "motive_attribution",
            SupportSortSemanticRejection::Coercion => "coercion",
            SupportSortSemanticRejection::DependencyOrGuilt => "dependency_or_guilt",
            SupportSortSemanticRejection::FalseReassurance => "false_reassurance",
            SupportSortSemanticRejection::ProductivityPressure => "productivity_pressure",
            SupportSortSemanticRejection::StructuralMinimization => "structural_minimization",
            SupportSortSemanticRejection::CrisisOrMedicalHandling => "crisis_or_medical_handling",
            SupportSortSemanticRejection::UnsafeContent => "unsafe_content",
        }
    }

    #[test]
    fn accepts_brief_choice_preserving_and_structurally_honest_results() {
        let accepted = [
            (
                "需求在周三由两项增加到五项",
                "有些烦乱（请核对）",
                "可以先确认新增范围和截止时间",
                "如果愿意，先列出一个需要确认的问题",
            ),
            (
                "当前工作量超过原计划",
                "感到疲惫（请核对）",
                "可以记录新增要求，并提出调整范围或寻求协助",
                "可先暂停十分钟，或找负责人确认优先级",
            ),
            (
                "评审没有通过，原因尚未确认",
                "可能有些失落（请核对）",
                "可以查看评审证据，也可以暂时停下",
                "愿意继续时，只确认一项最小问题",
            ),
        ];
        for (fact, feeling, controllable, next_step) in accepted {
            validate_support_sort_semantics(fact, feeling, controllable, next_step).unwrap();
        }
    }

    #[test]
    fn rejects_every_frozen_semantic_harm_category() {
        let rejected = [
            (
                SupportSortSemanticRejection::CatDialogue,
                ["需求变了", "圆 圆懂你", "可以暂停", "先确认范围"],
            ),
            (
                SupportSortSemanticRejection::Diagnosis,
                ["需求变了", "你这是焦虑症", "可以暂停", "先确认范围"],
            ),
            (
                SupportSortSemanticRejection::MotiveAttribution,
                ["对方就是故意打压你", "有些生气", "可以记录", "先确认事实"],
            ),
            (
                SupportSortSemanticRejection::Coercion,
                ["任务失败", "有些失落", "你必须继续", "马上重试"],
            ),
            (
                SupportSortSemanticRejection::DependencyOrGuilt,
                ["任务失败", "圆圆会难过", "可以暂停", "先休息"],
            ),
            (
                SupportSortSemanticRejection::FalseReassurance,
                ["任务失败", "有些失落", "一定会没事", "肯定能解决"],
            ),
            (
                SupportSortSemanticRejection::ProductivityPressure,
                ["任务失败", "有些疲惫", "休息后效率会更高", "尽快恢复工作"],
            ),
            (
                SupportSortSemanticRejection::StructuralMinimization,
                ["工作量增加", "你太敏感", "调整心态就好", "不要抱怨"],
            ),
            (
                SupportSortSemanticRejection::CrisisOrMedicalHandling,
                ["出现自残想法", "很危险", "请拨打心理热线", "增加药物剂量"],
            ),
            (
                SupportSortSemanticRejection::UnsafeContent,
                [
                    "详情见https://example.invalid",
                    "有些烦",
                    "可以查看",
                    "打开链接",
                ],
            ),
        ];
        for (expected, [fact, feeling, controllable, next_step]) in rejected {
            assert_eq!(
                validate_support_sort_semantics(fact, feeling, controllable, next_step),
                Err(expected)
            );
        }
    }

    #[test]
    fn coercive_wording_is_field_specific_and_user_quotes_remain_factual() {
        validate_support_sort_semantics(
            "负责人原话是“你必须今天完成”",
            "感到有压力（请核对）",
            "可以记录原话并确认优先级",
            "如果愿意，先保存这条事实",
        )
        .unwrap();
        assert_eq!(
            validate_support_sort_semantics(
                "截止时间是今天",
                "感到有压力（请核对）",
                "你必须今天完成",
                "马上继续工作",
            ),
            Err(SupportSortSemanticRejection::Coercion)
        );
    }

    #[test]
    fn rejects_oversized_multiline_and_direction_control_cells() {
        for invalid in [
            "x".repeat(MAX_FACT_BYTES + 1),
            "两行\n事实".to_owned(),
            "方向\u{202e}翻转".to_owned(),
        ] {
            assert_eq!(
                validate_support_sort_semantics(
                    &invalid,
                    "有些烦（请核对）",
                    "可以暂停",
                    "先确认范围",
                ),
                Err(SupportSortSemanticRejection::InvalidShape)
            );
        }
    }

    #[test]
    fn versioned_professional_pre_review_fixture_remains_enforced() {
        let fixture: SemanticFixture = serde_json::from_str(include_str!(
            "../tests/fixtures/support_sort_semantic_pre_review_v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        assert_eq!(fixture.purpose, "engineering_pre_review_only");
        assert!(!fixture.accepted.is_empty());
        assert!(!fixture.rejected.is_empty());

        for case in fixture.accepted {
            validate_support_sort_semantics(
                &case.fact,
                &case.feeling,
                &case.controllable,
                &case.next_step,
            )
            .unwrap_or_else(|rejection| {
                panic!(
                    "accepted fixture {} was rejected as {}",
                    case.case_id,
                    rejection_code(rejection)
                )
            });
        }
        for case in fixture.rejected {
            let rejection = validate_support_sort_semantics(
                &case.fact,
                &case.feeling,
                &case.controllable,
                &case.next_step,
            )
            .unwrap_err();
            assert_eq!(
                rejection_code(rejection),
                case.expected,
                "rejected fixture {} returned the wrong category",
                case.case_id
            );
        }
    }
}
