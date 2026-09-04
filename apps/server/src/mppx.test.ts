import { describe, expect, it, vi } from "vitest";
import {
  MppxRequester,
  PaidMppRequestError,
  selectChargeChallenge,
} from "./mppx.js";

const challenge = (amount: number) => {
  const request = Buffer.from(
    JSON.stringify({
      amount: String(amount),
      currency: "0x20C000000000000000000000b9537d11c60E8b50",
      methodDetails: { chainId: 4217, feePayer: true },
      recipient: "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe",
    }),
  ).toString("base64url");
  return `Payment id="charge-1", realm="example.test", method="tempo", intent="charge", request="${request}"`;
};

describe("MppxRequester", () => {
  it("selects a supported charge only inside the reserved request budget", () => {
    expect(selectChargeChallenge(challenge(325), 1_000).amountMicros).toBe(325);
    expect(() => selectChargeChallenge(challenge(1_001), 1_000)).toThrow(
      "exceeds the reserved request budget",
    );
  });

  it("probes, signs the selected challenge, and retries with authorization", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: { "www-authenticate": challenge(325) },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "payment-receipt": "receipt",
          },
        }),
      );
    const sign = vi.fn(async () => "Payment credential");
    const requester = new MppxRequester({
      account: "agent-world",
      fetch: fetchMock,
      sign,
    });

    const result = await requester.requestJson<{ choices: unknown[] }>(
      "https://example.test/chat",
      { prompt: "hello" },
      1_000,
    );

    expect(sign).toHaveBeenCalledWith(challenge(325));
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Payment credential");
    expect(result).toMatchObject({
      body: { choices: [] },
      amountMicros: 325,
      metadata: { account: "agent-world", paymentReceipt: "receipt" },
    });
  });

  it("reports the paid amount when the provider rejects a paid request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: { "www-authenticate": challenge(50_000) },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Bad model" } }), {
          status: 400,
          headers: { "payment-receipt": "failed-request-receipt" },
        }),
      );
    const requester = new MppxRequester({
      account: "agent-world",
      fetch: fetchMock,
      sign: async () => "Payment credential",
    });

    const error = await requester
      .requestJson("https://example.test/images", {}, 50_000)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidMppRequestError);
    expect(error).toMatchObject({
      amountMicros: 50_000,
      metadata: {
        account: "agent-world",
        paymentReceipt: "failed-request-receipt",
      },
    });
  });
});
