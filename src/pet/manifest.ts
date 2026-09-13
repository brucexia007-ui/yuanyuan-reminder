export type StandardAnimationName =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "activity-jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type SleepAnimationName = "sleep-enter" | "sleeping" | "wake-up";
export type LifeAnimationName =
  | "grooming"
  | "grooming-chest"
  | "grooming-flank"
  | "stretching"
  | "yawning"
  | "meowing"
  | "belly-up"
  | "belly-down"
  | "focus-calm"
  | "eating-food"
  | "drinking-water"
  | "treat-follow"
  | "wand-play"
  | "wand-reach"
  | "wand-swipe"
  | "wand-return"
  | "pet-nuzzle"
  | "ball-bat"
  | "ball-pickup"
  | "ball-carry"
  | "ball-drop"
  | "alert-glass-paws";
export type LearningAnimationName =
  | "learning-study-sit"
  | "learning-study-curious"
  | "learning-press-correct"
  | "learning-press-wrong";
export type SceneAnimationName =
  | "spa-enter"
  | "spa-loop"
  | "spa-exit"
  | "meal-alert"
  | "meal-wait"
  | "hydration-alert"
  | "hydration-wait"
  | "work-focus-loop"
  | "work-fatigue-enter"
  | "work-fatigue-loop"
  | "work-recover"
  | "warmup-alert"
  | "warmup-loop"
  | "study-focus-loop"
  | "study-curious"
  | "night-enter"
  | "night-loop"
  | "night-exit";
export type AnimationName =
  | StandardAnimationName
  | SleepAnimationName
  | LifeAnimationName
  | LearningAnimationName
  | SceneAnimationName;

export type SpriteSheetName = "standard" | "sleep" | "life" | "learning" | "scene";

export interface AnimationDefinition {
  sheet?: SpriteSheetName;
  row: number;
  frames: number[];
  durations: number[];
  loopStart: number | null;
  staticFrame: number;
}

export interface PetManifest {
  id: string;
  displayName: string;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  spritesheet: string;
  sleepSpritesheet: string;
  lifeSpritesheet: string;
  lifeRows: number;
  learningSpritesheet: string;
  learningRows: number;
  sceneSpritesheet: string;
  sceneRows: number;
  animations: Record<AnimationName, AnimationDefinition>;
}

type RawAnimationDefinition = Omit<AnimationDefinition, "staticFrame"> & {
  staticFrame?: number;
};

const SCENE_ROWS = [
  "spa-enter",
  "spa-loop",
  "spa-exit",
  "meal-alert",
  "meal-wait",
  "hydration-alert",
  "hydration-wait",
  "work-focus-loop",
  "work-fatigue-enter",
  "work-fatigue-loop",
  "work-recover",
  "warmup-alert",
  "warmup-loop",
  "study-focus-loop",
  "study-curious",
  "night-enter",
  "night-loop",
  "night-exit",
] as const satisfies readonly SceneAnimationName[];

export function hasValidSceneCapability(candidate: Partial<PetManifest>): boolean {
  if (
    candidate.columns !== 8 ||
    candidate.sceneRows !== SCENE_ROWS.length ||
    typeof candidate.sceneSpritesheet !== "string" ||
    !candidate.sceneSpritesheet.startsWith("/assets/pet/") ||
    !candidate.animations
  ) {
    return false;
  }
  const animations = candidate.animations as Partial<
    Record<AnimationName, RawAnimationDefinition>
  >;
  return SCENE_ROWS.every((name, rowIndex) => {
    const definition = animations[name];
    return Boolean(
      definition &&
        definition.sheet === "scene" &&
        definition.row === rowIndex &&
        definition.frames.length > 0 &&
        definition.frames.length === definition.durations.length &&
        definition.frames.every(
          (frame) => Number.isInteger(frame) && frame >= 0 && frame < 8,
        ) &&
        definition.durations.every(
          (duration) => Number.isFinite(duration) && duration > 0,
        ) &&
        Number.isInteger(definition.staticFrame) &&
        definition.staticFrame !== undefined &&
        definition.staticFrame >= 0 &&
        definition.staticFrame < 8 &&
        (definition.loopStart === null ||
          (Number.isInteger(definition.loopStart) &&
            definition.loopStart >= 0 &&
            definition.loopStart < definition.frames.length)),
    );
  });
}

function normalizeAnimations(
  animations: Record<AnimationName, RawAnimationDefinition>,
): Record<AnimationName, AnimationDefinition> {
  return Object.fromEntries(
    Object.entries(animations).map(([name, definition]) => [
      name,
      {
        ...definition,
        staticFrame: definition.staticFrame ?? definition.frames[0] ?? 0,
      },
    ]),
  ) as Record<AnimationName, AnimationDefinition>;
}

export const fallbackManifest: PetManifest = {
  id: "yuanyuan-reminder",
  displayName: "圆圆",
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 11,
  spritesheet: "/assets/pet/spritesheet.webp",
  sleepSpritesheet: "/assets/pet/sleep-atlas.webp",
  lifeSpritesheet: "/assets/pet/life-atlas.webp",
  lifeRows: 21,
  learningSpritesheet: "/assets/pet/learning-atlas.webp",
  learningRows: 4,
  sceneSpritesheet: "/assets/pet/scene-atlas.webp",
  sceneRows: 18,
  animations: normalizeAnimations({
    idle: {
      row: 0,
      frames: [0, 1, 2, 3, 4, 5],
      durations: [450, 120, 120, 180, 180, 550],
      loopStart: 0,
    },
    "running-right": row(1, 8, 110, 180),
    "running-left": row(2, 8, 110, 180),
    waving: row(3, 4, 160, 260),
    jumping: { ...row(4, 5, 140, 260), loopStart: null },
    "activity-jumping": {
      row: 4,
      frames: [0, 1, 2, 3, 4, 3, 2, 1],
      durations: [150, 115, 105, 110, 150, 110, 105, 125],
      loopStart: 0,
    },
    failed: { ...row(5, 8, 180, 320), loopStart: null },
    waiting: row(6, 6, 180, 320),
    running: row(7, 6, 150, 240),
    review: { ...row(8, 6, 180, 300), loopStart: null },
    "sleep-enter": {
      ...row(0, 8, 120, 180),
      sheet: "sleep",
      loopStart: null,
    },
    sleeping: { ...row(1, 8, 280, 360), sheet: "sleep" },
    "wake-up": {
      ...row(2, 8, 100, 180),
      sheet: "sleep",
      loopStart: null,
    },
    grooming: lifeRowWithFrames(
      0,
      [0, 1, 2, 3, 4, 5, 4, 3, 4, 5, 6, 7],
      [400, 300, 300, 260, 260, 320, 260, 260, 260, 320, 320, 440],
    ),
    "grooming-chest": lifeRowWithFrames(
      1,
      [0, 1, 2, 3, 4, 5, 4, 5, 6, 7],
      [360, 300, 280, 320, 320, 360, 300, 360, 340, 480],
    ),
    "grooming-flank": lifeRowWithFrames(
      2,
      [0, 1, 2, 3, 4, 5, 4, 5, 6, 7],
      [360, 300, 280, 340, 360, 420, 340, 420, 360, 500],
    ),
    stretching: lifeRow(3, [220, 180, 160, 220, 360, 180, 180, 320]),
    yawning: lifeRow(4, [240, 220, 180, 180, 320, 180, 200, 360]),
    meowing: lifeRow(5, [260, 160, 180, 240, 220, 180, 200, 360]),
    "belly-up": lifeRow(6, [220, 200, 200, 220, 240, 240, 280, 450]),
    "belly-down": {
      sheet: "life",
      row: 6,
      frames: [7, 6, 5, 4, 3, 2, 1, 0],
      durations: [220, 200, 200, 220, 220, 200, 200, 320],
      loopStart: null,
    },
    "focus-calm": {
      ...lifeRowWithFrames(
        7,
        [4, 5, 6, 7, 6, 5],
        [900, 700, 260, 1100, 260, 700],
      ),
      loopStart: 0,
    },
    "eating-food": {
      ...lifeRow(8, [320, 280, 260, 260, 280, 300, 520, 320]),
      loopStart: 1,
    },
    "drinking-water": {
      ...lifeRow(9, [340, 280, 240, 240, 240, 260, 300, 340]),
      loopStart: 1,
    },
    "treat-follow": {
      ...lifeRow(10, Array.from({ length: 8 }, () => 400)),
      loopStart: null,
    },
    "wand-play": {
      ...lifeRow(11, [95, 85, 80, 75, 75, 80, 90, 100]),
      loopStart: 0,
    },
    "pet-nuzzle": {
      ...lifeRow(12, [110, 95, 85, 80, 80, 90, 100, 120]),
      loopStart: 0,
    },
    "ball-bat": {
      ...lifeRow(13, [180, 140, 140, 180, 140, 140, 180, 260]),
      loopStart: null,
    },
    "wand-reach": {
      ...lifeRow(14, Array.from({ length: 8 }, () => 160)),
      loopStart: null,
    },
    "wand-swipe": {
      ...lifeRow(15, Array.from({ length: 8 }, () => 120)),
      loopStart: null,
    },
    "wand-return": {
      ...lifeRow(16, Array.from({ length: 8 }, () => 145)),
      loopStart: null,
    },
    "ball-pickup": {
      ...lifeRow(17, [180, 160, 160, 180, 180, 180, 200, 280]),
      loopStart: null,
    },
    "ball-carry": {
      ...lifeRow(18, [230, 220, 230, 220, 230, 220, 230, 220]),
      loopStart: 0,
    },
    "ball-drop": {
      ...lifeRow(19, [180, 160, 160, 180, 180, 200, 220, 420]),
      loopStart: null,
    },
    "alert-glass-paws": {
      ...lifeRow(20, [190, 150, 145, 190, 170, 150, 145, 210]),
      loopStart: null,
    },
    "learning-study-sit": {
      sheet: "learning",
      row: 0,
      frames: [0, 1, 2, 4, 5, 6, 7],
      durations: [720, 520, 420, 240, 560, 680, 760],
      loopStart: 0,
    },
    "learning-study-curious": {
      sheet: "learning",
      row: 1,
      frames: [0, 1, 2, 3, 4, 5, 6, 7],
      durations: [180, 160, 170, 220, 240, 180, 170, 220],
      loopStart: null,
    },
    "learning-press-correct": {
      sheet: "learning",
      row: 2,
      frames: [0, 1, 2, 3, 4, 5, 6, 7],
      durations: [150, 120, 110, 105, 100, 190, 125, 180],
      loopStart: null,
    },
    "learning-press-wrong": {
      sheet: "learning",
      row: 3,
      frames: [0, 1, 2, 3, 4, 5, 6, 7],
      durations: [150, 120, 110, 105, 100, 190, 125, 180],
      loopStart: null,
    },
    "spa-enter": sceneRow(0, false, 7),
    "spa-loop": sceneRow(1, true, 3, 320),
    "spa-exit": sceneRow(2, false, 7),
    "meal-alert": sceneRow(3, false, 7),
    "meal-wait": sceneRow(4, true, 2, 280),
    "hydration-alert": sceneRow(5, false, 7),
    "hydration-wait": sceneRow(6, true, 2, 280),
    "work-focus-loop": sceneRow(7, true, 2, 300),
    "work-fatigue-enter": sceneRow(8, false, 7),
    "work-fatigue-loop": sceneRow(9, true, 3, 360),
    "work-recover": sceneRow(10, false, 7),
    "warmup-alert": sceneRow(11, false, 7),
    "warmup-loop": sceneRow(12, true, 3, 250),
    "study-focus-loop": sceneRow(13, true, 2, 320),
    "study-curious": sceneRow(14, false, 7),
    "night-enter": sceneRow(15, false, 7),
    "night-loop": sceneRow(16, true, 3, 380),
    "night-exit": sceneRow(17, false, 7),
  }),
};

function sceneRow(
  rowIndex: number,
  loop: boolean,
  staticFrame: number,
  duration = 150,
): AnimationDefinition {
  return {
    sheet: "scene",
    row: rowIndex,
    frames: Array.from({ length: 8 }, (_, index) => index),
    durations: Array.from({ length: 8 }, () => duration),
    loopStart: loop ? 0 : null,
    staticFrame,
  };
}

function lifeRow(rowIndex: number, durations: number[]): AnimationDefinition {
  return {
    sheet: "life",
    row: rowIndex,
    frames: Array.from({ length: 8 }, (_, index) => index),
    durations,
    loopStart: null,
    staticFrame: 0,
  };
}

function lifeRowWithFrames(
  rowIndex: number,
  frames: number[],
  durations: number[],
): AnimationDefinition {
  return {
    sheet: "life",
    row: rowIndex,
    frames,
    durations,
    loopStart: null,
    staticFrame: frames[0] ?? 0,
  };
}

function row(
  rowIndex: number,
  count: number,
  duration: number,
  lastDuration: number,
): AnimationDefinition {
  return {
    row: rowIndex,
    frames: Array.from({ length: count }, (_, index) => index),
    durations: Array.from({ length: count }, (_, index) =>
      index === count - 1 ? lastDuration : duration,
    ),
    loopStart: 0,
    staticFrame: 0,
  };
}

let manifestPromise: Promise<PetManifest> | null = null;

export function loadPetManifest(): Promise<PetManifest> {
  manifestPromise ??= fetch("/assets/pet/pet-manifest.json")
    .then(async (response) => {
      if (!response.ok) throw new Error(`pet manifest ${response.status}`);
      const candidate = (await response.json()) as Partial<PetManifest>;
      if (!hasValidSceneCapability(candidate)) {
        throw new Error("pet manifest scene capability mismatch");
      }
      return {
        ...fallbackManifest,
        ...candidate,
        animations: normalizeAnimations({
          ...fallbackManifest.animations,
          ...candidate.animations,
        }),
      } as PetManifest;
    })
    .catch(() => fallbackManifest);
  return manifestPromise;
}

export const lookDirections = [
  "up",
  "up-right-1",
  "up-right",
  "right-up",
  "right",
  "right-down",
  "down-right",
  "down-right-1",
  "down",
  "down-left-1",
  "down-left",
  "left-down",
  "left",
  "left-up",
  "up-left",
  "up-left-1",
] as const;
