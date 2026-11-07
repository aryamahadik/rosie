// T-410: the HMAC helper verifies a published vector and refuses a changed byte. The vectors are RFC 4231 test cases 1
// and 2 (HMAC-SHA-256), not a real key; the webhook secret below is a made-up test string.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_SECONDS,
  signHmacSha256,
  signedWebhookString,
  verifyHmacSha256,
  verifyWebhookSignature,
} from "./hmac";

const RFC4231_CASE_1 = {
  key: "\u000b".repeat(20),
  data: "Hi There",
  mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
};
const RFC4231_CASE_2 = {
  key: "Jefe",
  data: "what do ya want for nothing?",
  mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
};

/** The hex with the byte at `index` changed by one bit. */
function flipByte(hex: string, index: number): string {
  const bytes = hex.match(/../g) ?? [];
  const changed = (Number.parseInt(bytes[index] ?? "00", 16) ^ 1).toString(16).padStart(2, "0");
  return [...bytes.slice(0, index), changed, ...bytes.slice(index + 1)].join("");
}

describe("HMAC-SHA256 helper", () => {
  it.each([RFC4231_CASE_1, RFC4231_CASE_2])(
    "signs the published vector $data",
    async ({ key, data, mac }) => {
      expect(await signHmacSha256(key, data)).toBe(mac);
    },
  );

  it.each([RFC4231_CASE_1, RFC4231_CASE_2])(
    "verifies the published vector $data",
    async ({ key, data, mac }) => {
      expect(await verifyHmacSha256(key, data, mac)).toBe(true);
      expect(await verifyHmacSha256(key, data, mac.toUpperCase())).toBe(true);
    },
  );

  it("refuses a changed byte of the signature, in every position", async () => {
    const { key, data, mac } = RFC4231_CASE_2;
    for (let index = 0; index < mac.length / 2; index += 1) {
      expect(await verifyHmacSha256(key, data, flipByte(mac, index))).toBe(false);
    }
  });

  it("refuses a changed byte of the message and a wrong key", async () => {
    const { key, data, mac } = RFC4231_CASE_2;
    expect(await verifyHmacSha256(key, data.replace("nothing", "nothinG"), mac)).toBe(false);
    expect(await verifyHmacSha256(key, `${data} `, mac)).toBe(false);
    expect(await verifyHmacSha256("Jeff", data, mac)).toBe(false);
  });

  it("refuses a signature that is truncated, too long, empty or not hex, without throwing", async () => {
    const { key, data, mac } = RFC4231_CASE_2;
    for (const bad of [mac.slice(0, -2), `${mac}00`, "", "zz", `${mac.slice(0, -1)}g`, mac.slice(0, -1)]) {
      expect(await verifyHmacSha256(key, data, bad)).toBe(false);
    }
  });
});

describe("webhook signature (id.timestamp.raw, 300 s window)", () => {
  const secret = "test-secret-not-a-real-key";
  const id = "evt-test-0001";
  const timestamp = "1790000000";
  const raw = '{"kind":"example","n":1}';
  const nowMs = 1_790_000_000_000;

  async function signed(): Promise<string> {
    return signHmacSha256(secret, signedWebhookString(id, timestamp, raw));
  }

  it("builds the signed string as id.timestamp.raw", () => {
    expect(signedWebhookString("a", "2", "b.c")).toBe("a.2.b.c");
  });

  it("accepts a good signature inside the window, at its edges", async () => {
    const signature = await signed();
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    for (const at of [nowMs, nowMs + 300_000, nowMs - 300_000]) {
      expect(await verifyWebhookSignature({ secret, id, timestamp, raw, signature, nowMs: at })).toEqual({
        valid: true,
      });
    }
  });

  it("refuses a stale or future timestamp", async () => {
    const signature = await signed();
    for (const at of [nowMs + 301_000, nowMs - 301_000]) {
      expect(await verifyWebhookSignature({ secret, id, timestamp, raw, signature, nowMs: at })).toEqual({
        valid: false,
        reason: "staleTimestamp",
      });
    }
  });

  it("refuses a timestamp that is not whole seconds", async () => {
    const signature = await signed();
    for (const bad of ["", "abc", "1790000000.5", "-1"]) {
      expect(await verifyWebhookSignature({ secret, id, timestamp: bad, raw, signature, nowMs })).toEqual({
        valid: false,
        reason: "badTimestamp",
      });
    }
  });

  it("refuses a changed byte of the body, the id, the signature, or another secret", async () => {
    const signature = await signed();
    const base = { secret, id, timestamp, raw, signature, nowMs };
    const bad = { valid: false, reason: "badSignature" };
    expect(await verifyWebhookSignature({ ...base, raw: raw.replace("1", "2") })).toEqual(bad);
    expect(await verifyWebhookSignature({ ...base, id: "evt-test-0002" })).toEqual(bad);
    expect(await verifyWebhookSignature({ ...base, signature: flipByte(signature, 31) })).toEqual(bad);
    expect(await verifyWebhookSignature({ ...base, secret: "another-test-secret" })).toEqual(bad);
  });

  it("takes its own window", async () => {
    const signature = await signed();
    const base = { secret, id, timestamp, raw, signature };
    expect(
      (await verifyWebhookSignature({ ...base, nowMs: nowMs + 31_000, toleranceSeconds: 30 })).valid,
    ).toBe(false);
    expect(
      (await verifyWebhookSignature({ ...base, nowMs: nowMs + 30_000, toleranceSeconds: 30 })).valid,
    ).toBe(true);
  });
});
