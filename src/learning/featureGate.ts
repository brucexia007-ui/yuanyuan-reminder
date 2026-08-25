export const LEARNING_PREVIEW_BUNDLE_MARKER = "yuanyuan-learning-preview-ui";

export function parseLearningBuildFlag(value: unknown): boolean {
  return value === "1";
}

export const learningBuildEnabled = __YUANYUAN_LEARNING_ENABLED__;
