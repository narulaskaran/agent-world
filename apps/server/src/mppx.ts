import { spawn } from "node:child_process";

const TEMPO_MAINNET_CHAIN_ID = 4217;
const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";

interface ChargeRequest {
  amount: string;
  currency: string;
  methodDetails?: { chainId?: number };
}

interface SelectedChallenge {
  value: string;
  id: string | null;
  amountMicros: number;
}

export interface MppxResult<T> {
  body: T;
  metadata: Record<string, unknown>;
  amountMicros: number;
}

export class PaidMppRequestError extends Error {
  constructor(
    message: string,
    readonly amountMicros: number,
    readonly metadata: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PaidMppRequestError";
  }
}

const attribute = (challenge: string, name: string): string | null =>
  challenge.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? null;

export function selectChargeChallenge(
  header: string,
  maxSpendMicros: number,
): SelectedChallenge {
  const supported = header
    .split(/,\s*(?=Payment\s)/)
    .flatMap((value) => {
      if (
        attribute(value, "method") !== "tempo" ||
        attribute(value, "intent") !== "charge"
      )
        return [];
      const encodedRequest = attribute(value, "request");
      if (!encodedRequest) return [];
      try {
        const request = JSON.parse(
          Buffer.from(encodedRequest, "base64url").toString("utf8"),
        ) as ChargeRequest;
        const amountMicros = Number(request.amount);
        if (
          request.currency.toLowerCase() !== TEMPO_USDC ||
          request.methodDetails?.chainId !== TEMPO_MAINNET_CHAIN_ID ||
          !Number.isSafeInteger(amountMicros) ||
          amountMicros <= 0
        ) {
          return [];
        }
        return [{ value, id: attribute(value, "id"), amountMicros }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.amountMicros - b.amountMicros);
  const selected = supported[0];
  if (!selected)
    throw new Error(
      "MPP endpoint did not offer a supported Tempo mainnet USDC charge",
    );
  if (selected.amountMicros > maxSpendMicros) {
    throw new Error(
      `MPP charge of $${(selected.amountMicros / 1_000_000).toFixed(6)} exceeds the reserved request budget`,
    );
  }
  return selected;
}

function signWithCli(
  binary: string,
  account: string,
  challenge: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "sign",
        "--challenge",
        challenge,
        "--account",
        account,
        "--network",
        "mainnet",
        "--format",
        "json",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(stderr.trim() || `mppx sign exited ${code}`));
      try {
        const authorization = (JSON.parse(stdout) as { authorization?: string })
          .authorization;
        if (!authorization)
          throw new Error("mppx sign returned no authorization");
        resolve(authorization);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export class MppxRequester {
  constructor(
    private readonly options: {
      binary?: string;
      account?: string;
      fetch?: typeof globalThis.fetch;
      sign?: (challenge: string) => Promise<string>;
    } = {},
  ) {}

  async requestJson<T>(
    url: string,
    body: unknown,
    maxSpendMicros: number,
  ): Promise<MppxResult<T>> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    } satisfies RequestInit;
    const challengeResponse = await fetcher(url, request);
    if (challengeResponse.status !== 402) {
      if (!challengeResponse.ok)
        throw new Error(`MPP endpoint returned ${challengeResponse.status}`);
      return {
        body: (await challengeResponse.json()) as T,
        metadata: { paid: false },
        amountMicros: 0,
      };
    }
    const header = challengeResponse.headers.get("www-authenticate");
    if (!header)
      throw new Error("MPP endpoint returned 402 without WWW-Authenticate");
    const selected = selectChargeChallenge(header, maxSpendMicros);
    const authorization = this.options.sign
      ? await this.options.sign(selected.value)
      : await signWithCli(
          this.options.binary ?? process.env.MPPX_BIN ?? "mppx",
          this.options.account ?? process.env.MPPX_ACCOUNT ?? "agent-world",
          selected.value,
        );
    const paidResponse = await fetcher(url, {
      ...request,
      headers: { ...request.headers, authorization },
    });
    const paymentMetadata = {
      account:
        this.options.account ?? process.env.MPPX_ACCOUNT ?? "agent-world",
      challengeId: selected.id,
      paymentReceipt: paidResponse.headers.get("payment-receipt"),
      transport: "mppx",
    };
    if (!paidResponse.ok) {
      const detail = (await paidResponse.text()).slice(0, 300);
      throw new PaidMppRequestError(
        `Paid MPP request returned ${paidResponse.status}${detail ? `: ${detail}` : ""}`,
        selected.amountMicros,
        paymentMetadata,
      );
    }
    return {
      body: (await paidResponse.json()) as T,
      amountMicros: selected.amountMicros,
      metadata: paymentMetadata,
    };
  }
}
