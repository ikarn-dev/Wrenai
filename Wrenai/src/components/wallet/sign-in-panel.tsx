"use client";

import { base64urlnopad } from "@scure/base";
import { Lock, Wallet } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { testnetApi } from "@/components/testnet/api";
import { Button } from "@/components/ui/button";
import { type Notice, StatusLine } from "@/components/ui/status-line";
import { completeSignIn, requestSignInChallenge } from "@/server/auth/actions";
import type { AppNetwork } from "@/shared/network";
import { nearConnector } from "./near-connector";
import {
  attempt,
  type FlowPhase,
  failureNotice,
  requestFailed,
  type Step,
  WALLETS_UNAVAILABLE,
  walletNotice,
} from "./notices";

const onWalletError = (error: unknown): Notice => walletNotice(error, "sign_in");
const onRequestError = (): Notice => requestFailed("sign_in");

// Each step names its own failure, so a wallet's "no" never reads as a server fault.
async function signInWithWallet(show: (label: string) => void): Promise<Step<Route>> {
  const connector = await attempt(nearConnector, () => WALLETS_UNAVAILABLE);
  if (!connector.ok) {
    return connector;
  }
  const walletId = await attempt(() => connector.value.selectWallet(), onWalletError);
  if (!walletId.ok) {
    return walletId;
  }
  show("Check your wallet");
  const wallet = await attempt(() => connector.value.connect({ walletId: walletId.value }), onWalletError);
  if (!wallet.ok) {
    return wallet;
  }
  const challenge = await attempt(requestSignInChallenge, onRequestError);
  if (!challenge.ok) {
    return challenge;
  }
  if (!challenge.value.ok) {
    return { ok: false, notice: failureNotice(challenge.value) };
  }
  const { message, recipient, nonce } = challenge.value.challenge;
  const signed = await attempt(
    () => wallet.value.signMessage({ message, recipient, nonce: base64urlnopad.decode(nonce) }),
    onWalletError,
  );
  if (!signed.ok) {
    return signed;
  }
  show("Signing in…");
  const { accountId, publicKey, signature } = signed.value;
  const result = await attempt(
    () => completeSignIn({ accountId, publicKey, signature, nonce }),
    onRequestError,
  );
  if (!result.ok) {
    return result;
  }
  return result.value.ok
    ? { ok: true, value: "/portfolio" }
    : { ok: false, notice: failureNotice(result.value) };
}

async function signInTestnet(show: (label: string) => void): Promise<Step<Route<"/testnet/portfolio">>> {
  try {
    const connector = await nearConnector("testnet");
    const walletId = await connector.selectWallet();
    const wallet = await connector.connect({ walletId });
    const challenge = z
      .object({ message: z.string(), recipient: z.string(), nonce: z.string() })
      .parse(await testnetApi({ command: "challenge" }));
    show("Check your wallet");
    const signed = await wallet.signMessage({
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: base64urlnopad.decode(challenge.nonce),
    });
    await testnetApi({
      command: "connect",
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      nonce: challenge.nonce,
    });
    return { ok: true, value: "/testnet/portfolio" };
  } catch (error) {
    return { ok: false, notice: walletNotice(error, "sign_in") };
  }
}

export function SignInPanel({ network = "mainnet" }: { readonly network?: AppNetwork }) {
  const router = useRouter();
  const [phase, setPhase] = useState<FlowPhase>({ kind: "idle" });

  async function signIn(): Promise<void> {
    setPhase({ kind: "working", label: "Choose a wallet" });
    const show = (label: string): void => setPhase({ kind: "working", label });
    const result = await (network === "testnet" ? signInTestnet(show) : signInWithWallet(show));
    if (!result.ok) {
      setPhase({ kind: "stopped", notice: result.notice });
      return;
    }
    if (network === "testnet") {
      window.location.replace(result.value);
      return;
    }
    router.replace(result.value);
    router.refresh();
  }

  // While working the button stays readable (aria-busy, not disabled) and ignores further clicks.
  const working = phase.kind === "working";
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="primary"
        size="lg"
        aria-busy={working}
        onClick={() => {
          if (!working) {
            void signIn();
          }
        }}
      >
        {working ? null : (
          <Wallet aria-hidden="true" size={18} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
        )}
        <span className="min-w-0 truncate text-h3 font-medium">
          {working ? phase.label : network === "testnet" ? "Connect testnet wallet" : "Connect NEAR wallet"}
        </span>
      </Button>
      <StatusLine
        notice={phase.kind === "stopped" ? phase.notice : null}
        note={
          <>
            <Lock aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
            <span className="min-w-0 text-small">Free to sign. Your keys stay in your wallet.</span>
          </>
        }
      />
    </div>
  );
}
