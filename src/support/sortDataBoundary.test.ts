import { describe, expect, it } from "vitest";

import {
  SORT_CONTENT_CLASSES,
  SORT_DISCLOSURE_VERSION,
  SORT_PURPOSE,
  SortDataBoundarySession,
  type SortProviderIdentity,
} from "./sortDataBoundary";
import source from "./sortDataBoundary.ts?raw";

const localProvider: SortProviderIdentity = {
  destination: "local_provider",
  providerKey: "local-provider",
  providerFingerprint: "A".repeat(64),
  available: true,
};

const cloudProvider: SortProviderIdentity = {
  destination: "cloud_provider",
  providerKey: "cloud-provider",
  providerFingerprint: "B".repeat(64),
  available: true,
};

function authorize(
  session: SortDataBoundarySession,
  provider = localProvider,
  nowUnixMs = 1_000,
) {
  session.selectProvider(provider);
  session.acknowledgeDisclosure();
  return session.authorizeOnce(nowUnixMs);
}

describe("sort data boundary", () => {
  it("requires a visible disclosure acknowledgement before one-use authorization", () => {
    const session = new SortDataBoundarySession();
    session.selectProvider(localProvider);
    expect(() => session.authorizeOnce(1_000)).toThrow(/acknowledged/);

    session.acknowledgeDisclosure();
    const receipt = session.authorizeOnce(1_000);
    expect(receipt).toEqual({
      schemaVersion: 1,
      purpose: SORT_PURPOSE,
      contentClasses: SORT_CONTENT_CLASSES,
      destination: "local_provider",
      providerKey: "local-provider",
      providerFingerprint: "A".repeat(64),
      disclosureVersion: SORT_DISCLOSURE_VERSION,
      issuedAtUnixMs: 1_000,
      expiresAtUnixMs: 301_000,
      oneUse: true,
    });
  });

  it("consumes exactly once and then requires fresh authorization", () => {
    const session = new SortDataBoundarySession();
    const receipt = authorize(session);
    expect(session.consumeAuthorization(2_000, localProvider)).toEqual(receipt);
    expect(session.submissionReceiptCount).toBe(1);
    expect(session.state).toMatchObject({
      stage: "reauthorization_required",
      reason: "used",
    });
    expect(() => session.consumeAuthorization(2_001, localProvider)).toThrow(
      /unavailable/,
    );
  });

  it("fails closed on expiry without producing a submission receipt", () => {
    const session = new SortDataBoundarySession();
    authorize(session, localProvider, 1_000);
    expect(() => session.consumeAuthorization(301_000, localProvider)).toThrow(
      /expired/,
    );
    expect(session.submissionReceiptCount).toBe(0);
    expect(session.state).toMatchObject({
      stage: "reauthorization_required",
      reason: "expired",
    });
  });

  it("invalidates authorization when destination or provider identity changes", () => {
    const destinationChange = new SortDataBoundarySession();
    authorize(destinationChange);
    expect(() =>
      destinationChange.consumeAuthorization(2_000, cloudProvider),
    ).toThrow(/changed/);
    expect(destinationChange.state).toMatchObject({
      stage: "reauthorization_required",
      reason: "destination_changed",
    });

    const providerChange = new SortDataBoundarySession();
    authorize(providerChange, cloudProvider);
    expect(() =>
      providerChange.consumeAuthorization(2_000, {
        ...cloudProvider,
        providerFingerprint: "C".repeat(64),
      }),
    ).toThrow(/changed/);
    expect(providerChange.state).toMatchObject({
      stage: "reauthorization_required",
      reason: "provider_changed",
    });
  });

  it("rejects unavailable or malformed providers before authorization", () => {
    const session = new SortDataBoundarySession();
    expect(() =>
      session.selectProvider({ ...localProvider, available: false }),
    ).toThrow(/unavailable/);
    expect(() =>
      session.selectProvider({ ...localProvider, providerKey: "../../provider" }),
    ).toThrow(/identity/);
    expect(() =>
      session.selectProvider({ ...localProvider, providerFingerprint: "unknown" }),
    ).toThrow(/fingerprint/);
    expect(() =>
      session.selectProvider({
        ...localProvider,
        destination: "remote_magic" as never,
      }),
    ).toThrow(/destination/);
    expect(session.state).toEqual({ stage: "choosing" });
  });

  it("keeps authorization snapshots immutable and rejects unsafe timestamps", () => {
    const session = new SortDataBoundarySession();
    const receipt = authorize(session);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.contentClasses)).toBe(true);
    expect(() => {
      (receipt as { providerKey: string }).providerKey = "tampered";
    }).toThrow();
    expect(session.state).toMatchObject({
      stage: "authorized",
      receipt: { providerKey: "local-provider" },
    });

    const overflow = new SortDataBoundarySession();
    overflow.selectProvider(localProvider);
    overflow.acknowledgeDisclosure();
    expect(() => overflow.authorizeOnce(Number.MAX_SAFE_INTEGER)).toThrow(/time/);
  });

  it("cancels without retaining a selection or producing a submission receipt", () => {
    const session = new SortDataBoundarySession();
    authorize(session, cloudProvider);
    session.cancel();
    expect(session.state).toEqual({ stage: "cancelled" });
    expect(session.submissionReceiptCount).toBe(0);
    expect(JSON.stringify(session.state)).not.toContain("cloud-provider");
  });

  it("contains no transport, persistence, logging, analytics or user-text field", () => {
    for (const forbidden of [
      "fetch(",
      "invoke(",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "console.",
      "analytics.",
      "userText",
      "ventText",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
