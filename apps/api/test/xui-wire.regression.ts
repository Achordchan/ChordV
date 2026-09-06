import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { XuiService } from "../src/modules/xui/xui.service";

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, payload: unknown, headers?: Record<string, string | string[]>) {
  response.writeHead(200, {
    "content-type": "application/json",
    ...(headers ?? {})
  });
  response.end(JSON.stringify(payload));
}

async function testEnsureClientUsesRealPanelWireProtocol() {
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    captured.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body
    });

    if (request.method === "GET" && request.url === "/csrf-token") {
      sendJson(response, { success: true, obj: "csrf-token-1" }, { "set-cookie": "csrf_sid=pre; Path=/; HttpOnly" });
      return;
    }

    if (request.method === "POST" && request.url === "/login") {
      sendJson(response, { success: true }, { "set-cookie": "session=ok; Path=/; HttpOnly" });
      return;
    }

    if (request.method === "GET" && request.url === "/panel/api/inbounds/get/7") {
      sendJson(response, {
        success: true,
        obj: {
          id: 7,
          settings: JSON.stringify({ clients: [] })
        }
      });
      return;
    }

    if (request.method === "POST" && request.url === "/panel/api/clients/add") {
      sendJson(response, { success: true });
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");

    const service = new XuiService();
    const result = await service.ensureClient(
      {
        id: "node_1",
        panelBaseUrl: `http://127.0.0.1:${address.port}`,
        panelApiBasePath: "",
        panelUsername: "achord",
        panelPassword: "secret",
        panelInboundId: 7,
        panelRequestTimeoutMs: 5000
      },
      {
        id: "client-uuid-1",
        email: "user@example.com",
        enable: true,
        flow: "xtls-rprx-vision",
        expiryTime: 1780000000000,
        limitIp: 0,
        totalGB: 0,
        subId: "",
        reset: 0,
        tgId: 0,
        comment: "Node A"
      }
    );

    assert.deepEqual(result, {
      email: "user@example.com",
      uuid: "client-uuid-1",
      inboundId: 7
    });

    assert.equal(captured.length, 4);
    const [csrf, login, inbound, addClient] = captured;

    assert.equal(csrf.method, "GET");
    assert.equal(csrf.url, "/csrf-token");
    assert.equal(csrf.headers.cookie, undefined);
    assert.equal(csrf.headers["user-agent"], "ChordV/0.1");
    assert.equal(csrf.headers["x-requested-with"], "XMLHttpRequest");

    assert.equal(login.method, "POST");
    assert.equal(login.url, "/login");
    assert.match(String(login.headers["content-type"]), /application\/x-www-form-urlencoded/);
    assert.equal(login.headers.cookie, "csrf_sid=pre");
    assert.equal(login.headers["x-csrf-token"], "csrf-token-1");
    const loginBody = new URLSearchParams(login.body);
    assert.equal(loginBody.get("username"), "achord");
    assert.equal(loginBody.get("password"), "secret");
    assert.equal(loginBody.get("twoFactorCode"), "");

    assert.equal(inbound.method, "GET");
    assert.equal(inbound.url, "/panel/api/inbounds/get/7");
    assert.equal(inbound.headers.cookie, "csrf_sid=pre; session=ok");
    assert.equal(inbound.headers["x-csrf-token"], undefined);

    assert.equal(addClient.method, "POST");
    assert.equal(addClient.url, "/panel/api/clients/add");
    assert.equal(addClient.headers.cookie, "csrf_sid=pre; session=ok");
    assert.equal(addClient.headers["x-csrf-token"], "csrf-token-1");
    assert.match(String(addClient.headers["content-type"]), /application\/json/);
    const addPayload = JSON.parse(addClient.body);
    assert.deepEqual(addPayload.inboundIds, [7]);
    assert.equal(addPayload.client.id, "client-uuid-1");
    assert.equal(addPayload.client.email, "user@example.com");
    assert.equal(addPayload.client.enable, true);
    assert.equal(addPayload.client.flow, "xtls-rprx-vision");
    assert.equal(addPayload.client.expiryTime, 1780000000000);
    assert.equal(addPayload.client.comment, "Node A");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function testUpdateClientNormalizesStringAllowedIps() {
  // Newer 3x-ui panels serve the client's allowedIPs as a bare string ("" when
  // empty) while the update endpoint's Go struct demands []string. Echoing the
  // fetched value back verbatim fails every update with
  // "cannot unmarshal string into Go struct field Client.allowedIPs" — the exact
  // production incident behind the stuck panel-sync jobs since 2026-08-10.
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    captured.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body
    });

    if (request.method === "GET" && request.url === "/csrf-token") {
      sendJson(response, { success: true, obj: "csrf-token-1" }, { "set-cookie": "csrf_sid=pre; Path=/; HttpOnly" });
      return;
    }

    if (request.method === "POST" && request.url === "/login") {
      sendJson(response, { success: true }, { "set-cookie": "session=ok; Path=/; HttpOnly" });
      return;
    }

    if (request.method === "GET" && request.url === "/panel/api/inbounds/get/7") {
      sendJson(response, {
        success: true,
        obj: {
          id: 7,
          settings: JSON.stringify({
            clients: [
              {
                id: "existing-uuid",
                email: "user@example.com",
                enable: false,
                flow: "",
                expiryTime: 0,
                limitIp: 0,
                totalGB: 0,
                reset: 0,
                // String form as served by newer panel versions.
                allowedIPs: ""
              }
            ]
          })
        }
      });
      return;
    }

    if (request.method === "GET" && request.url === "/panel/api/clients/get/user%40example.com") {
      sendJson(response, {
        success: true,
        obj: {
          client: {
            id: "existing-uuid",
            email: "user@example.com",
            enable: false,
            flow: "",
            expiryTime: 0,
            limitIp: 0,
            totalGB: 0,
            reset: 0,
            allowedIPs: "10.0.0.1, 10.0.0.2"
          }
        }
      });
      return;
    }

    if (request.method === "POST" && request.url === "/panel/api/clients/update/user%40example.com") {
      sendJson(response, { success: true });
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");

    const service = new XuiService();
    await service.ensureClient(
      {
        id: "node_1",
        panelBaseUrl: `http://127.0.0.1:${address.port}`,
        panelApiBasePath: "",
        panelUsername: "achord",
        panelPassword: "secret",
        panelInboundId: 7,
        panelRequestTimeoutMs: 5000
      },
      {
        id: "client-uuid-1",
        email: "user@example.com",
        enable: true,
        flow: "xtls-rprx-vision",
        expiryTime: 1780000000000,
        limitIp: 0,
        totalGB: 0,
        subId: "",
        reset: 0,
        tgId: 0,
        comment: "Node A"
      }
    );

    const update = captured.find((request) => request.url === "/panel/api/clients/update/user%40example.com");
    assert.ok(update, "ensureClient must update the existing disabled client");
    const updatePayload = JSON.parse(update.body);
    assert.deepEqual(
      updatePayload.allowedIPs,
      ["10.0.0.1", "10.0.0.2"],
      "comma-separated allowedIPs must be normalized to the array the panel's Go struct expects"
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function main() {
  await testEnsureClientUsesRealPanelWireProtocol();
  await testUpdateClientNormalizesStringAllowedIps();
  console.log("xui wire regression checks passed");
}

main();
