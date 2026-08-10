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
export type AnimationName =
  | StandardAnimationName
  | SleepAnimationName
  | LifeAnimationName;

export type SpriteSheetName = "standard" | "sleep" | "life";

export interface AnimationDefinition {
  sheet?: SpriteSheetName;
  row: number;
  frames: number[];
  durations: number[];
  loopStart: number | null;
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
  animations: Record<AnimationName, AnimationDefinition>;
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
  animations: {
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
  },
};

function lifeRow(rowIndex: number, durations: number[]): AnimationDefinition {
  return {
    sheet: "life",
    row: rowIndex,
    frames: Array.from({ length: 8 }, (_, index) => index),
    durations,
    loopStart: null,
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
  };
}

let manifestPromise: Promise<PetManifest> | null = null;

export function loadPetManifest(): Promise<PetManifest> {
  manifestPromise ??= fetch("/assets/pet/pet-manifest.json")
    .then(async (response) => {
      if (!response.ok) throw new Error(`pet manifest ${response.status}`);
      return (await response.json()) as PetManifest;
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
