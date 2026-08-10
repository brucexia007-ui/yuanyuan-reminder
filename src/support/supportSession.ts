const MAX_EPHEMERAL_TEXT_BYTES = 16 * 1024;

export type SupportPath =
  | "stay_close"
  | "vent_ephemeral"
  | "gentle_reset"
  | "move_together"
  | "sort_things_out"
  | "give_space";

export type SupportGate = {
  professionalReviewPassed: boolean;
  regionalSafetyResourcesReady: boolean;
};

export type SupportReleaseMode = "basic_three_paths" | "full_support_box";

export type SupportSessionState =
  | { stage: "approach" }
  | { stage: "choosing" }
  | { stage: "active"; path: SupportPath }
  | { stage: "optional_check_in"; path: Exclude<SupportPath, "give_space"> }
  | { stage: "closed" };

const basicPaths: readonly SupportPath[] = [
  "stay_close",
  "move_together",
  "give_space",
];

const fullPaths: readonly SupportPath[] = [
  "stay_close",
  "vent_ephemeral",
  "gentle_reset",
  "move_together",
  "sort_things_out",
  "give_space",
];

export function supportReleaseMode(gate: SupportGate): SupportReleaseMode {
  return gate.professionalReviewPassed && gate.regionalSafetyResourcesReady
    ? "full_support_box"
    : "basic_three_paths";
}

export function availableSupportPaths(gate: SupportGate): readonly SupportPath[] {
  return supportReleaseMode(gate) === "full_support_box" ? fullPaths : basicPaths;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validEphemeralText(value: string): boolean {
  return (
    utf8Length(value) <= MAX_EPHEMERAL_TEXT_BYTES &&
    !/[\0\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

/**
 * In-memory state for a user-triggered support interaction. It deliberately
 * has no persistence, provider, logging, analytics or backend dependency.
 * Closing the session clears the only retained text reference. A later sort
 * or model flow must start separately and show a fresh data-boundary prompt.
 */
export class EphemeralSupportSession {
  #state: SupportSessionState = { stage: "approach" };
  #ventText = "";
  #checkInUsed = false;
  readonly #paths: ReadonlySet<SupportPath>;

  constructor(gate: SupportGate) {
    this.#paths = new Set(availableSupportPaths(gate));
  }

  get state(): SupportSessionState {
    return this.#state;
  }

  get ventText(): string {
    return this.#state.stage === "active" && this.#state.path === "vent_ephemeral"
      ? this.#ventText
      : "";
  }

  offerChoices(): void {
    if (this.#state.stage !== "approach") throw new Error("invalid support transition");
    this.#state = { stage: "choosing" };
  }

  choose(path: SupportPath): void {
    if (this.#state.stage !== "choosing" || !this.#paths.has(path)) {
      throw new Error("support path is unavailable");
    }
    this.#state = { stage: "active", path };
  }

  replaceVentText(value: string): void {
    if (this.#state.stage !== "active" || this.#state.path !== "vent_ephemeral") {
      throw new Error("ephemeral listening is not active");
    }
    if (!validEphemeralText(value)) throw new Error("ephemeral text is invalid");
    this.#ventText = value;
  }

  finishActivePath(): void {
    if (this.#state.stage !== "active") throw new Error("invalid support transition");
    const path = this.#state.path;
    this.#clearVentText();
    if (path === "give_space") {
      this.#state = { stage: "closed" };
      return;
    }
    this.#state = { stage: "optional_check_in", path };
  }

  answerOptionalCheckIn(): void {
    if (this.#state.stage !== "optional_check_in" || this.#checkInUsed) {
      throw new Error("optional check-in is unavailable");
    }
    this.#checkInUsed = true;
    this.#state = { stage: "closed" };
  }

  skipOptionalCheckIn(): void {
    if (this.#state.stage !== "optional_check_in") {
      throw new Error("optional check-in is unavailable");
    }
    this.#state = { stage: "closed" };
  }

  close(): void {
    this.#clearVentText();
    this.#state = { stage: "closed" };
  }

  #clearVentText(): void {
    this.#ventText = "";
  }
}
