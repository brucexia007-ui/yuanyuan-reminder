import { describe, expect, it } from "vitest";

import {
  answerLearningQuestion,
  deleteLearningData,
  getCurrentLearningQuestion,
  getLearningDataSummary,
  getLearningHome,
  startManualLearningSession,
  updateLearningSettings,
} from "./demoBackend";

describe("learning browser demo data contract", () => {
  it("resets settings and content when all learning data is deleted", async () => {
    const beforeLearning = await getLearningHome();
    expect(beforeLearning.newAvailableCount).toBe(1);
    expect(beforeLearning.newStudiedTodayCount).toBe(0);

    const session = await startManualLearningSession(3);
    const firstQuestion = await getCurrentLearningQuestion(session.sessionId);
    await answerLearningQuestion(
      session.sessionId,
      firstQuestion.questionId,
      `${firstQuestion.questionId}-${firstQuestion.cardId}`,
      "demo-answer-1",
      800,
    );
    const secondQuestion = await getCurrentLearningQuestion(session.sessionId);
    await answerLearningQuestion(
      session.sessionId,
      secondQuestion.questionId,
      `${secondQuestion.questionId}-${secondQuestion.cardId}`,
      "demo-answer-2",
      900,
    );

    const afterLearning = await getLearningHome();
    expect(afterLearning.newAvailableCount).toBe(0);
    expect(afterLearning.newRemainingCount).toBe(0);
    expect(afterLearning.newStudiedTodayCount).toBe(1);

    await updateLearningSettings({
      cardsPerSession: 5,
      dailyNewLimit: 30,
    });

    const result = await deleteLearningData(
      "all_learning_data",
      "DELETE ALL LEARNING DATA",
    );
    const home = await getLearningHome();
    const summary = await getLearningDataSummary();

    expect(result.keptCardCount).toBe(0);
    expect(home.capabilities.contentPackReady).toBe(false);
    expect(home.settings.mode).toBe("manual_only");
    expect(home.settings.cardsPerSession).toBe(3);
    expect(home.settings.dailyNewLimit).toBe(5);
    expect(summary.cardCount).toBe(0);
    expect(summary.sources).toEqual([]);
    expect(summary.packs).toEqual([]);
  });
});
