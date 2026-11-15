// The local stand-in for Linq that the probe's dry run calls (T-1121 phase 1). It listens on 127.0.0.1 alone, keeps
// each request it takes in memory (for the test), writes nothing and logs nothing. Its answers follow the shapes the
// repository records (contracts/port-linq/README.md spike rows 13 and 14; vendor samples
// capability-check-imessage-response.json, send-message-response.json and error-2024.json), with the request's own
// address echoed back, as Linq's documents show. Its answers to contacts/add and to a chat opened by number are its own
// shapes: those calls are not in the repository (wire.mjs, CONTACT_ADD_PATH and CHAT_CREATE_PATH). A phone the test (or
// the probe's own dry run) marks with simulateStop gets 403 with code 2024 on every later send, override_optout or not
// (README spike row 15: override_optout does not lift the block).

import { createServer } from "node:http";

import {
  API_PATH,
  CHAT_CREATE_PATH,
  CHECK_IMESSAGE_PATH,
  CHECK_RCS_PATH,
  CONTACT_ADD_PATH,
} from "./wire.mjs";

function linqError(status, code, message) {
  return { success: false, error: { status, code, message }, trace_id: "linq-trace-stub" };
}

function parsed(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * Starts the stand-in on 127.0.0.1 and a port the system picks. Gives its url (http://127.0.0.1:<port>), the requests
 * it took ({method, url, headers, body}, in order), simulateStop(phone) and close().
 */
export async function startStub() {
  const requests = [];
  const stopped = new Set();
  let serial = 0;

  const answer = (method, url, headers, text) => {
    if (!/^Bearer \S+$/.test(headers.authorization ?? "")) return [401, linqError(401, null, "Unauthorized")];
    if (method !== "POST" || !url.startsWith(API_PATH)) return [404, linqError(404, null, "Not found")];
    const body = parsed(text);
    const route = url.slice(API_PATH.length);
    if (route === CHECK_IMESSAGE_PATH) {
      return [200, { address: body.address, available: true, reason: null, selected_service: "iMessage" }];
    }
    if (route === CHECK_RCS_PATH) {
      return [
        200,
        { address: body.address, available: false, reason: "not_supported", selected_service: "iMessage" },
      ];
    }
    if (route === CONTACT_ADD_PATH) {
      return [
        201,
        { contact: { id: "linq-contact-stub", phone_number: body.phone_number }, stub_shape: true },
      ];
    }
    if (route === CHAT_CREATE_PATH) {
      serial += 1;
      const to = Array.isArray(body.to) ? body.to[0] : undefined;
      if (typeof to === "string" && stopped.has(to)) {
        return [403, linqError(403, 2024, "Recipient asked you to stop messaging them")];
      }
      return [
        201,
        {
          chat_id: `linq-chat-stub-${String(serial)}`,
          message: {
            id: `linq-msg-stub-${String(serial)}`,
            created_at: new Date().toISOString(),
            delivery_status: "pending",
            is_read: false,
            parts: Array.isArray(body.message?.parts) ? body.message.parts : [],
            service: "iMessage",
            preferred_service: null,
          },
          to: body.to,
        },
      ];
    }
    return [404, linqError(404, null, "Not found")];
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const headers = { ...request.headers };
      requests.push({ method: request.method, url: request.url, headers, body: text });
      const [status, body] = answer(request.method, request.url ?? "", headers, text);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${String(address.port)}`;

  return {
    url,
    requests,
    /** From now on, a send to this phone answers 403 with code 2024, as after the phone texted STOP. */
    simulateStop(phone) {
      stopped.add(phone);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
