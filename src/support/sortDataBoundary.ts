const AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROVIDER_FINGERPRINT_PATTERN = /^[A-F0-9]{64}$/;

export const SORT_DISCLOSURE_VERSION = 1 as const;
export const SORT_PURPOSE = "structure_fact_feeling_control_next_step" as const;
export const SORT_CONTENT_CLASSES = Object.freeze(["user_entered_text"] as const);

export type SortDestination = "local_provider" | "cloud_provider";
export type SortReauthorizationReason =
  | "destination_changed"
  | "provider_changed"
  | "expired"
  | "used";

export type SortProviderIdentity = {
  readonly destination: SortDestination;
  readonly providerKey: string;
  readonly providerFingerprint: string;
  readonly available: boolean;
};

type SortSelection = Omit<SortProviderIdentity, "available">;

export type SortAuthorizationReceipt = {
  readonly schemaVersion: 1;
  readonly purpose: typeof SORT_PURPOSE;
  readonly contentClasses: typeof SORT_CONTENT_CLASSES;
  readonly destination: SortDestination;
  readonly providerKey: string;
  readonly providerFingerprint: string;
  readonly disclosureVersion: typeof SORT_DISCLOSURE_VERSION;
  readonly issuedAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly oneUse: true;
};

export type SortDataBoundaryState =
  | { stage: "choosing" }
  | { stage: "review"; selection: SortSelection; disclosureAcknowledged: boolean }
  | { stage: "authorized"; receipt: SortAuthorizationReceipt }
  | {
      stage: "reauthorization_required";
      reason: SortReauthorizationReason;
      selection: SortSelection | null;
    }
  | { stage: "cancelled" };

function validUnixMs(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER - AUTHORIZATION_TTL_MS
  );
}

function normalizeProvider(provider: SortProviderIdentity): SortSelection {
  if (!provider.available) throw new Error("sort provider is unavailable");
  if (
    provider.destination !== "local_provider" &&
    provider.destination !== "cloud_provider"
  ) {
    throw new Error("sort destination is invalid");
  }
  if (!PROVIDER_KEY_PATTERN.test(provider.providerKey)) {
    throw new Error("sort provider identity is invalid");
  }
  if (!PROVIDER_FINGERPRINT_PATTERN.test(provider.providerFingerprint)) {
    throw new Error("sort provider fingerprint is invalid");
  }
  return Object.freeze({
    destination: provider.destination,
    providerKey: provider.providerKey,
    providerFingerprint: provider.providerFingerprint,
  });
}

function sameSelection(left: SortSelection, right: SortSelection): boolean {
  return (
    left.destination === right.destination &&
    left.providerKey === right.providerKey &&
    left.providerFingerprint === right.providerFingerprint
  );
}

/**
 * Development-only interaction contract. It never accepts user text and has
 * no transport, persistence, telemetry, backend or provider dependency.
 * A production capability must be issued and consumed by Rust instead.
 */
export class SortDataBoundarySession {
  #state: SortDataBoundaryState = Object.freeze({ stage: "choosing" });
  #submissionReceiptCount = 0;

  get state(): SortDataBoundaryState {
    return this.#state;
  }

  get submissionReceiptCount(): number {
    return this.#submissionReceiptCount;
  }

  selectProvider(provider: SortProviderIdentity): void {
    const selection = normalizeProvider(provider);
    this.#state = Object.freeze({
      stage: "review",
      selection,
      disclosureAcknowledged: false,
    });
  }

  acknowledgeDisclosure(): void {
    if (this.#state.stage !== "review") {
      throw new Error("sort data flow is not ready for review");
    }
    this.#state = Object.freeze({
      ...this.#state,
      disclosureAcknowledged: true,
    });
  }

  authorizeOnce(nowUnixMs: number): SortAuthorizationReceipt {
    if (!validUnixMs(nowUnixMs)) throw new Error("authorization time is invalid");
    if (this.#state.stage !== "review" || !this.#state.disclosureAcknowledged) {
      throw new Error("sort data flow must be acknowledged before authorization");
    }
    const receipt: SortAuthorizationReceipt = Object.freeze({
      schemaVersion: 1,
      purpose: SORT_PURPOSE,
      contentClasses: SORT_CONTENT_CLASSES,
      destination: this.#state.selection.destination,
      providerKey: this.#state.selection.providerKey,
      providerFingerprint: this.#state.selection.providerFingerprint,
      disclosureVersion: SORT_DISCLOSURE_VERSION,
      issuedAtUnixMs: nowUnixMs,
      expiresAtUnixMs: nowUnixMs + AUTHORIZATION_TTL_MS,
      oneUse: true,
    });
    this.#state = Object.freeze({ stage: "authorized", receipt });
    return receipt;
  }

  consumeAuthorization(
    nowUnixMs: number,
    currentProvider: SortProviderIdentity,
  ): SortAuthorizationReceipt {
    if (!validUnixMs(nowUnixMs)) throw new Error("authorization time is invalid");
    if (this.#state.stage !== "authorized") {
      throw new Error("sort authorization is unavailable");
    }
    const receipt = this.#state.receipt;
    const currentSelection = normalizeProvider(currentProvider);
    const authorizedSelection = this.#selectionFromReceipt(receipt);
    if (!sameSelection(authorizedSelection, currentSelection)) {
      this.#state = Object.freeze({
        stage: "reauthorization_required",
        reason:
          authorizedSelection.destination === currentSelection.destination
            ? "provider_changed"
            : "destination_changed",
        selection: currentSelection,
      });
      throw new Error("sort provider changed after authorization");
    }
    if (nowUnixMs >= receipt.expiresAtUnixMs) {
      this.#state = Object.freeze({
        stage: "reauthorization_required",
        reason: "expired",
        selection: authorizedSelection,
      });
      throw new Error("sort authorization expired");
    }
    this.#submissionReceiptCount += 1;
    this.#state = Object.freeze({
      stage: "reauthorization_required",
      reason: "used",
      selection: authorizedSelection,
    });
    return receipt;
  }

  cancel(): void {
    this.#state = Object.freeze({ stage: "cancelled" });
  }

  restart(): void {
    this.#submissionReceiptCount = 0;
    this.#state = Object.freeze({ stage: "choosing" });
  }

  #selectionFromReceipt(receipt: SortAuthorizationReceipt): SortSelection {
    return Object.freeze({
      destination: receipt.destination,
      providerKey: receipt.providerKey,
      providerFingerprint: receipt.providerFingerprint,
    });
  }
}
