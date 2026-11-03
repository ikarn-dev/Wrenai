import { encode } from "@msgpack/msgpack";
import { keccak256, Signature, type SigningKey, TypedDataEncoder } from "ethers";
import { z } from "zod";
import { type HlUsdSend, hlUsdSendSchema } from "@/shared/perps-return";
import { type HlAction, hlActionSchema } from "./contracts";

const domain = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
const types = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};
export interface HlSignature {
  readonly r: string;
  readonly s: string;
  readonly v: number;
}
/** Mainnet-only L1 signing from the official Python SDK's message-pack + nonce protocol. */
export function hlActionHash(action: HlAction, nonce: number, expiresAfter: number | null): string {
  z.number().int().nonnegative().safe().parse(nonce);
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(nonce));
  const expiry = expiresAfter === null ? Buffer.alloc(0) : Buffer.alloc(9);
  if (expiresAfter !== null) {
    z.number().int().positive().safe().parse(expiresAfter);
    expiry.writeBigUInt64BE(BigInt(expiresAfter), 1);
  }
  const canonical: unknown = JSON.parse(JSON.stringify(hlActionSchema.parse(action)));
  return keccak256(Buffer.concat([encode(canonical), time, Buffer.from([0]), expiry]));
}
export function signHlAction(
  wallet: { readonly signingKey: SigningKey },
  action: HlAction,
  nonce: number,
  expiresAfter: number | null,
): HlSignature {
  const digest = TypedDataEncoder.hash(domain, types, {
    source: "a",
    connectionId: hlActionHash(action, nonce, expiresAfter),
  });
  const signature = Signature.from(wallet.signingKey.sign(digest));
  return { r: signature.r, s: signature.s, v: signature.v };
}
/** Official user-signed transfer domain, distinct from L1 orders: https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py */
export function signHlTransfer(wallet: { readonly signingKey: SigningKey }, raw: HlUsdSend): HlSignature {
  const action = hlUsdSendSchema.parse(raw);
  const digest = TypedDataEncoder.hash(
    {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421614,
      verifyingContract: domain.verifyingContract,
    },
    {
      "HyperliquidTransaction:UsdSend": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    },
    action,
  );
  const signature = Signature.from(wallet.signingKey.sign(digest));
  return { r: signature.r, s: signature.s, v: signature.v };
}
