import { describe, expect, it } from "vitest";
import { privateTokenId } from "./confidential-intents";
import { MAX_PROVIDER_INTENT_VALIDITY_MS, validateGeneratedIntent } from "./intents-payload";
import fixture from "./oneclick-intent.fixture.json";

function binding(): {
  signerId: string;
  scope: "confidential";
  depositAddress: string;
  inputAssetId: string;
  inputUnits: string;
  providerDeadline: string;
  maximumValidityMs: number;
  now: number;
} {
  return {
    signerId: "intents.near",
    scope: "confidential",
    depositAddress: fixture.quote.quote.depositAddress,
    inputAssetId: fixture.request.originAsset,
    inputUnits: fixture.request.amount,
    providerDeadline: fixture.quote.quote.deadline,
    maximumValidityMs: 300_000,
    now: Date.parse(fixture.quote.timestamp),
  };
}
function shortLivedSample(): { intent: typeof fixture.generated; binding: ReturnType<typeof binding> } {
  const expected = binding();
  expected.providerDeadline = new Date(expected.now + 120_000).toISOString();
  const nonce = Buffer.from(fixture.generated.intent.payload.nonce, "base64");
  nonce.writeBigUInt64LE(BigInt(Date.parse(expected.providerDeadline)) * 1_000_000n, 9);
  const message = {
    deadline: expected.providerDeadline,
    intents: [
      {
        intent: "transfer",
        receiver_id: expected.depositAddress,
        tokens: { [privateTokenId(expected.inputAssetId)]: expected.inputUnits },
      },
    ],
    signer_id: expected.signerId,
  };
  return {
    binding: expected,
    intent: {
      ...fixture.generated,
      intent: {
        ...fixture.generated.intent,
        payload: {
          ...fixture.generated.intent.payload,
          nonce: nonce.toString("base64"),
          message: JSON.stringify(message),
        },
      },
    },
  };
}

describe("exact signed Intents payload boundary", () => {
  it("rejects the real unsigned sample's extended deadline instead of silently granting three days", () => {
    expect(Date.parse(fixture.quote.quote.deadline) - Date.parse(fixture.request.deadline)).toBe(259_200_000);
    expect(() => validateGeneratedIntent(fixture.generated, binding())).toThrow("authorization lifetime");
  });
  it("supports the approved provider validity only with the exact original nonce, deadline and amount", () => {
    const result = validateGeneratedIntent(fixture.generated, {
      ...binding(),
      maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
    });
    expect(result.intent.intent.payload.message).toBe(fixture.generated.intent.payload.message);
    expect(() =>
      validateGeneratedIntent(fixture.generated, {
        ...binding(),
        maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
        providerDeadline: fixture.request.deadline,
      }),
    ).toThrow();
  });
  it("preserves the original bounded message and binds a deterministic signing hash", () => {
    const sample = shortLivedSample();
    const result = validateGeneratedIntent(sample.intent, sample.binding);
    expect(result.intent.intent.payload.message).toBe(sample.intent.intent.payload.message);
    expect(validateGeneratedIntent(sample.intent, sample.binding).payloadHash).toBe(result.payloadHash);
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects redirected funds, added actions, unknown tokens, unsafe callbacks and wrong contracts", () => {
    const sample = shortLivedSample();
    const badMessages = [
      { deadline: sample.binding.providerDeadline, signer_id: "attacker.near", intents: [] },
      {
        deadline: sample.binding.providerDeadline,
        signer_id: sample.binding.signerId,
        intents: [{ intent: "add_public_key", public_key: "ed25519:attacker" }],
      },
      {
        deadline: sample.binding.providerDeadline,
        signer_id: sample.binding.signerId,
        intents: [
          {
            intent: "transfer",
            receiver_id: "f".repeat(64),
            tokens: { [privateTokenId(sample.binding.inputAssetId)]: "10000000" },
          },
        ],
      },
      {
        deadline: sample.binding.providerDeadline,
        signer_id: sample.binding.signerId,
        intents: [
          {
            intent: "transfer",
            receiver_id: sample.binding.depositAddress,
            tokens: { [privateTokenId(sample.binding.inputAssetId)]: "10000001" },
          },
        ],
      },
      {
        deadline: sample.binding.providerDeadline,
        signer_id: sample.binding.signerId,
        intents: [
          {
            intent: "transfer",
            receiver_id: sample.binding.depositAddress,
            tokens: { [privateTokenId(sample.binding.inputAssetId)]: "10000000", "imt:extra": "1" },
          },
        ],
      },
    ];
    for (const message of badMessages) {
      expect(() =>
        validateGeneratedIntent(
          {
            ...sample.intent,
            intent: {
              ...sample.intent.intent,
              payload: { ...sample.intent.intent.payload, message: JSON.stringify(message) },
            },
          },
          sample.binding,
        ),
      ).toThrow();
    }
    for (const change of [
      { recipient: "intents.near" },
      { callbackUrl: "https://untrusted.example" },
      { nonce: "A".repeat(44) },
    ]) {
      expect(() =>
        validateGeneratedIntent(
          {
            ...sample.intent,
            intent: { ...sample.intent.intent, payload: { ...sample.intent.intent.payload, ...change } },
          },
          sample.binding,
        ),
      ).toThrow();
    }
  });
  it("rejects duplicate JSON keys and mismatched confidential IMT mappings", () => {
    const sample = shortLivedSample();
    const duplicate = sample.intent.intent.payload.message.replace(
      '"signer_id":',
      '"signer_id":"attacker.near","signer_id":',
    );
    expect(() =>
      validateGeneratedIntent(
        {
          ...sample.intent,
          intent: {
            ...sample.intent.intent,
            payload: { ...sample.intent.intent.payload, message: duplicate },
          },
        },
        sample.binding,
      ),
    ).toThrow();
    expect(() =>
      validateGeneratedIntent(sample.intent, { ...sample.binding, inputAssetId: "nep141:wrong.near" }),
    ).toThrow();
  });
});
