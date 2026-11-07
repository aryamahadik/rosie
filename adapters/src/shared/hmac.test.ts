// T-410: the HMAC helper verifies a published vector and refuses a changed byte. The vectors are RFC 4231 test cases 1
// and 2 (HMAC-SHA-256), not a real key; the webhook secret below is a made-up test string.
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_SECONDS,
  signHmacSha256,
  signedWebhookString,
  signLinqWebhook,
  verifyHmacSha256,
  verifyLinqWebhookSignature,
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

describe("Linq webhook signature (whsec_ key, v1,<base64>, T-1075)", () => {
  // Fictional keys built here: 32 and 24 bytes of a counting pattern, never a real key.
  const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  const keyBytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
  const secret = `whsec_${b64(keyBytes)}`;
  const otherSecret = `whsec_${b64(Uint8Array.from({ length: 24 }, (_, i) => (i * 5 + 1) % 256))}`;
  const id = "msg_test_0001";
  const timestamp = "1790000000";
  const raw = '{"event_type":"example","n":1}';
  const nowMs = 1_790_000_000_000;
  const base = { secret, id, timestamp, raw, nowMs };

  /** The expected header, computed with node:crypto, apart from the code under test. */
  function reference(key: Uint8Array, body = raw): string {
    const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    return `v1,${mac}`;
  }

  it("verifies a signature computed in Linq's form", async () => {
    const signature = reference(keyBytes);
    expect(await verifyLinqWebhookSignature({ ...base, signature })).toEqual({ valid: true });
    expect(await signLinqWebhook(secret, id, timestamp, raw)).toBe(signature);
  });

  it("fails the old hex form of the same body, the raw secret as key, and a bare base64 signature", async () => {
    const hex = await signHmacSha256(secret, `${id}.${timestamp}.${raw}`);
    expect(await verifyLinqWebhookSignature({ ...base, signature: hex })).toEqual({
      valid: false,
      reason: "badSignature",
    });
    expect(await verifyLinqWebhookSignature({ ...base, signature: `v1,${hex}` })).toEqual({
      valid: false,
      reason: "badSignature",
    });
    const bare = reference(keyBytes).slice(3);
    expect(await verifyLinqWebhookSignature({ ...base, signature: bare })).toEqual({
      valid: false,
      reason: "badSignature",
    });
    // The hex form still refuses Linq's signature, so the two schemes stay apart.
    expect(await verifyWebhookSignature({ ...base, signature: reference(keyBytes) })).toEqual({
      valid: false,
      reason: "badSignature",
    });
  });

  it("passes a header of two entries where only the second matches, in either order", async () => {
    const good = reference(keyBytes);
    const wrong = reference(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(await verifyLinqWebhookSignature({ ...base, signature: `${wrong} ${good}` })).toEqual({
      valid: true,
    });
    expect(await verifyLinqWebhookSignature({ ...base, signature: `${good} ${wrong}` })).toEqual({
      valid: true,
    });
    expect(await verifyLinqWebhookSignature({ ...base, signature: `${wrong} ${wrong}` })).toEqual({
      valid: false,
      reason: "badSignature",
    });
  });

  it("fails a changed byte of the body, the id, the signature, a wrong key and a stale timestamp", async () => {
    const signature = reference(keyBytes);
    const bad = { valid: false, reason: "badSignature" };
    expect(await verifyLinqWebhookSignature({ ...base, signature, raw: raw.replace("1", "2") })).toEqual(bad);
    expect(await verifyLinqWebhookSignature({ ...base, signature, id: "msg_test_0002" })).toEqual(bad);
    const mac = Uint8Array.from(atob(signature.slice(3)), (c) => c.charCodeAt(0));
    mac[5] = (mac[5] ?? 0) ^ 1;
    expect(await verifyLinqWebhookSignature({ ...base, signature: `v1,${b64(mac)}` })).toEqual(bad);
    expect(await verifyLinqWebhookSignature({ ...base, signature, secret: otherSecret })).toEqual(bad);
    for (const at of [nowMs + 301_000, nowMs - 301_000]) {
      expect(await verifyLinqWebhookSignature({ ...base, signature, nowMs: at })).toEqual({
        valid: false,
        reason: "staleTimestamp",
      });
    }
    for (const at of [nowMs + 300_000, nowMs - 300_000]) {
      expect(await verifyLinqWebhookSignature({ ...base, signature, nowMs: at })).toEqual({ valid: true });
    }
    expect(await verifyLinqWebhookSignature({ ...base, signature, timestamp: "abc" })).toEqual({
      valid: false,
      reason: "badTimestamp",
    });
  });

  it("never throws on a missing v1, prefix, junk, an empty header or a secret that is not whsec_ plus base64", async () => {
    const good = reference(keyBytes);
    const bad = { valid: false, reason: "badSignature" };
    for (const signature of [
      "",
      " ",
      "v1",
      "v1,",
      "v2,abc",
      `v2${good.slice(2)}`,
      "v1,!!!!",
      "v1,abc",
      good.slice(3),
    ]) {
      expect(await verifyLinqWebhookSignature({ ...base, signature })).toEqual(bad);
    }
    for (const badSecret of ["", "whsec_", "whsec_!!!", "not-a-whsec-key", b64(keyBytes)]) {
      expect(await verifyLinqWebhookSignature({ ...base, signature: good, secret: badSecret })).toEqual(bad);
    }
    await expect(signLinqWebhook("not-a-whsec-key", id, timestamp, raw)).rejects.toThrow();
  });

  it("does not put the secret in a result or an error", async () => {
    const result = await verifyLinqWebhookSignature({ ...base, signature: "v1,abc" });
    expect(JSON.stringify(result)).not.toContain(secret);
    const error = await signLinqWebhook("whsec_!!!", id, timestamp, raw).catch((e: unknown) => String(e));
    expect(error).not.toContain("!!!");
  });
});
