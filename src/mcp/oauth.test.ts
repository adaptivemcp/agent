import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { acquireToken, authorizationServerMetadataUrl, protectedResourceUrl } from "./oauth.js";

/**
 * The OAuth path against a real (local) authorization server.
 *
 * These are the properties that matter, and each is asserted rather than assumed:
 * the client asks for the **path-based** protected-resource metadata (not the root),
 * registers dynamically, sends PKCE **S256**, names the **resource** on both requests, and
 * exchanges the code with a verifier that actually matches its challenge.
 */

const base64url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface Recorded {
  rootPrmRequests: number;
  registrationBody?: Record<string, unknown>;
  authorizeQuery?: URLSearchParams;
  challenge?: string;
  verifier?: string;
  tokenBody?: URLSearchParams;
}

function startAuthServer(state: { fail?: string } = {}): {
  server: Server;
  seen: Recorded;
} {
  const seen: Recorded = { rootPrmRequests: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      seen.rootPrmRequests += 1;
      send(404, { error: "not_found" });
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      send(200, { resource: base, authorization_servers: [base] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      send(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        seen.registrationBody = JSON.parse(raw) as Record<string, unknown>;
        send(201, { client_id: "test-client-id", client_secret: "test-client-secret" });
      });
      return;
    }
    if (url.pathname === "/authorize") {
      seen.authorizeQuery = url.searchParams;
      seen.challenge = url.searchParams.get("code_challenge") ?? undefined;
      if (state.fail) {
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("error", state.fail);
        response.writeHead(302, { location: redirect.toString() }).end();
        return;
      }
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "test-auth-code");
      const returned = url.searchParams.get("state");
      if (returned) redirect.searchParams.set("state", returned);
      response.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        seen.tokenBody = new URLSearchParams(raw);
        seen.verifier = seen.tokenBody.get("code_verifier") ?? undefined;
        send(200, {
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read",
        });
      });
      return;
    }
    send(404, { error: "unknown_route", path: url.pathname });
  });

  let base = "";
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });
  // `base` is read lazily by the handler closure, so a request that races `listen`
  // still resolves it to the bound port.
  return { server, seen };
}

describe("OAuth discovery and authorization", () => {
  let running: Server | undefined;

  afterEach(async () => {
    if (!running) return;
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  });

  it("discovers, registers, and exchanges a PKCE code", async () => {
    const auth = startAuthServer();
    running = auth.server;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resourceUrl = `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}/mcp`;

    const token = await acquireToken(
      resourceUrl,
      { authorize: "fetch", clientName: "agent-test" },
      { timeoutMs: 5000 },
    );

    expect(token.accessToken).toBe("test-access-token");
    expect(token.tokenType).toBe("Bearer");
    expect(token.clientId).toBe("test-client-id");
    expect(token.scope).toBe("read");

    // Path-based PRM, never the root: the root is the trap in `auth/metadata-default`.
    expect(auth.seen.rootPrmRequests).toBe(0);

    // Dynamic registration names the client and asks for a public client.
    expect(auth.seen.registrationBody).toMatchObject({
      client_name: "agent-test",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(auth.seen.registrationBody?.redirect_uris).toEqual([
      "http://127.0.0.1:8765/oauth/callback",
    ]);

    // The authorization request names the resource and asks for S256.
    expect(auth.seen.authorizeQuery?.get("response_type")).toBe("code");
    expect(auth.seen.authorizeQuery?.get("code_challenge_method")).toBe("S256");
    expect(auth.seen.authorizeQuery?.get("resource")).toBe(resourceUrl);

    // The verifier the token request sent actually matches the challenge.
    const challenge = auth.seen.challenge;
    const verifier = auth.seen.verifier;
    expect(challenge).toBeDefined();
    expect(verifier).toBeDefined();
    const computed = base64url(createHash("sha256").update(verifier!).digest());
    expect(computed).toBe(challenge);
  }, 20_000);

  it("reports an authorization error instead of a half-authenticated session", async () => {
    const auth = startAuthServer({ fail: "access_denied" });
    running = auth.server;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resourceUrl = `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}/mcp`;

    await expect(
      acquireToken(resourceUrl, { authorize: "fetch" }, { timeoutMs: 5000 }),
    ).rejects.toThrow(/authorization failed: access_denied/);
  }, 20_000);

  it("builds RFC 9728 and RFC 8414 locations", () => {
    expect(protectedResourceUrl("https://host.example/mcp")).toBe(
      "https://host.example/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceUrl("https://host.example")).toBe(
      "https://host.example/.well-known/oauth-protected-resource",
    );
    expect(authorizationServerMetadataUrl("https://host.example")).toBe(
      "https://host.example/.well-known/oauth-authorization-server",
    );
    // The well-known segment goes before the issuer's path, not appended to it.
    expect(authorizationServerMetadataUrl("https://host.example/tenant1")).toBe(
      "https://host.example/.well-known/oauth-authorization-server/tenant1",
    );
  });
});
