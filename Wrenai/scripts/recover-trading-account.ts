import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KeyPairEd25519 } from "@near-js/crypto";
import { base58 } from "@scure/base";
import { Wallet } from "ethers";
import { z } from "zod";
import { derivePerpsWallet } from "../src/shared/perps-derivation.ts";
import { openRecoveryFile } from "../src/shared/recovery-file.ts";
import type { RecoveryPayload } from "../src/shared/trading-recovery.ts";

interface RecoveredTradingKeys {
  readonly recovery: RecoveryPayload;
  readonly agent: { readonly index: number; readonly address: string; readonly privateKey: string } | null;
}

/** Offline decryption only: no application login, environment credentials, signatures or network requests. */
export async function recoverTradingKeys(
  text: string,
  password: string,
  agentIndex?: number,
): Promise<RecoveredTradingKeys> {
  const recovery = await openRecoveryFile(text, password);
  const native = new KeyPairEd25519(recovery.native.privateKey.slice("ed25519:".length));
  if (
    native.getPublicKey().toString() !== recovery.native.publicKey ||
    Buffer.from(base58.decode(recovery.native.publicKey.slice("ed25519:".length))).toString("hex") !==
      recovery.native.accountId ||
    new Wallet(recovery.perps.privateKey).address.toLowerCase() !== recovery.perps.address.toLowerCase()
  ) {
    throw new Error("The recovered keys do not match the backup's account identities.");
  }
  if (agentIndex === undefined) {
    return { recovery, agent: null };
  }
  if (recovery.format !== "wrenai-trading-recovery-v2") {
    throw new Error("This older backup has no derived agent addresses.");
  }
  const wallet = derivePerpsWallet(recovery.perps.privateKey, agentIndex);
  return { recovery, agent: { index: agentIndex, address: wallet.address, privateKey: wallet.privateKey } };
}

function hiddenPassword(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(new Error("Use an interactive terminal to enter the backup password."));
  }
  process.stdout.write("Backup password: ");
  return new Promise((accept, reject) => {
    let password = "";
    const wasRaw = input.isRaw;
    const cleanup = (): void => {
      input.off("data", data);
      input.off("error", fail);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
    };
    const fail = (): void => {
      cleanup();
      password = "";
      reject(new Error("Password entry was canceled."));
    };
    const data = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") {
          fail();
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          accept(password);
          password = "";
          return;
        }
        if (char === "\u007f" || char === "\b") {
          password = password.slice(0, -1);
        } else if (char >= " " && password.length < 1024) {
          password += char;
        }
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", data);
    input.once("error", fail);
    input.resume();
  });
}

async function main(): Promise<void> {
  const args = z
    .strictObject({
      input: z.string().min(1),
      output: z.string().min(1).endsWith(".key"),
      index: z.coerce.number().int().min(0).max(999).optional(),
    })
    .safeParse({
      input: process.argv[2],
      output: process.argv[3],
      ...(process.argv[4] === undefined ? {} : { index: process.argv[4] }),
    });
  if (!args.success || process.argv.length > 5) {
    throw new Error("Usage: pnpm recover <encrypted-backup.json> <new-private-output.key> [agent-index]");
  }
  if ((await stat(args.data.input)).size > 40_000) {
    throw new Error("The encrypted backup exceeds its supported size.");
  }
  const recovered = await recoverTradingKeys(
    await readFile(args.data.input, "utf8"),
    await hiddenPassword(),
    args.data.index,
  );
  // Never overwrite the encrypted backup or an existing file; recovered keys remain local and owner-readable.
  await writeFile(args.data.output, JSON.stringify(recovered, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write("Recovered keys saved locally. No network request or transaction was made.\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Recovery failed."}\n`);
    process.exitCode = 1;
  });
}
