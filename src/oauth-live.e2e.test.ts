import { createServer, type Server } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireToken } from "./mcp/oauth.js";

/**
 * The OAuth client against a **real** identity provider.
 *
 * Conformance runs scripted servers; they prove the protocol shapes but not interoperability
 * with someone else's implementation. This test talks to a live provider (a Keycloak realm in
 * the recorded run) through discovery, client authentication and a real token, then verifies
 * the token's signature against the provider's JWKS.
 *
 * Skipped unless the environment names a provider and a machine client:
 *
 *   AGENT_OIDC_ISSUER        e.g. http://127.0.0.1:8090/realms/agent
 *   AGENT_OIDC_AUDIENCE      expected `aud` value
 *   AGENT_OIDC_CLIENT_ID     service-account client id
 *   AGENT_OIDC_CLIENT_SECRET its secret
 *   AGENT_OIDC_SCOPE         optional single scope to request and assert
 *
 * The provider must also publish protected-resource metadata for the client to discover the
 * issuer, or the test's stand-in server does that here: a real MCP server publishes
 * `/.well-known/oauth-protected-resource/mcp`, and Keycloak does not.
 */
const ISSUER = process.env.AGENT_OIDC_ISSUER;
const AUDIENCE = process.env.AGENT_OIDC_AUDIENCE;
const CLIENT_ID = process.env.AGENT_OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.AGENT_OIDC_CLIENT_SECRET;
const SCOPE = process.env.AGENT_OIDC_SCOPE;
const live = Boolean(ISSUER && AUDIENCE && CLIENT_ID && CLIENT_SECRET);

interface Claims {
  iss?: string;
  aud?: string | string[];
  scope?: string;
  exp?: number;
}

function decode(token: string): { header: Record<string, unknown>; claims: Claims } {
  const [header, payload] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header as string, "base64url").toString()),
    claims: JSON.parse(Buffer.from(payload as string, "base64url").toString()),
  };
}

async function jwksUrl(issuer: string): Promise<string> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  expect(response.ok, `openid-configuration at ${issuer}`).toBe(true);
  const document = (await response.json()) as { jwks_uri?: string };
  expect(document.jwks_uri).toBeTruthy();
  return document.jwks_uri as string;
}

async function verifySignature(token: string, uri: string): Promise<boolean> {
  const { header } = decode(token);
  if (header.alg !== "RS256") return false;
  const document = (await (await fetch(uri)).json()) as {
    keys: Array<Record<string, unknown> & { kid?: string }>;
  };
  const jwk = document.keys.find((key) => key.kid === header.kid);
  if (!jwk) return false;
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const [header64, payload64, signature64] = token.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header64}.${payload64}`),
    key,
    Buffer.from(signature64 as string, "base64url"),
  );
}

describe.skipIf(!live)("OAuth client against a live identity provider", () => {
  let prm: Server;
  let resourceUrl: string;
  let jwks: string;

  beforeAll(async () => {
    jwks = await jwksUrl(ISSUER as string);
    // Real MCP servers publish protected-resource metadata; the identity provider does not.
    // This stand-in serves only that document, so discovery is genuinely exercised.
    prm = createServer((request, response) => {
      if (request.url?.startsWith("/.well-known/oauth-protected-resource")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            resource: resourceUrl,
            authorization_servers: [ISSUER],
            ...(SCOPE ? { scopes_supported: [SCOPE] } : {}),
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => prm.listen(0, "127.0.0.1", resolve));
    const { port } = prm.address() as AddressInfo;
    resourceUrl = `http://127.0.0.1:${port}/mcp`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => prm?.close(() => resolve()));
  });

  it("acquires a client_credentials token the provider actually signed", async () => {
    const session = await acquireToken(
      resourceUrl,
      {
        grant: "client_credentials",
        clientId: CLIENT_ID as string,
        clientSecret: CLIENT_SECRET as string,
        ...(SCOPE ? { scopes: [SCOPE] } : {}),
      },
      { timeoutMs: 15_000 },
    );

    const token = session.header().replace(/^Bearer /, "");
    expect(await verifySignature(token, jwks)).toBe(true);
    const { claims } = decode(token);
    expect(claims.iss).toBe(ISSUER);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    expect(audiences).toContain(AUDIENCE);
    if (SCOPE) expect(claims.scope ?? "").toContain(SCOPE);
  }, 30_000);

  it("refreshes by re-requesting, and the new token also verifies", async () => {
    const session = await acquireToken(
      resourceUrl,
      {
        grant: "client_credentials",
        clientId: CLIENT_ID as string,
        clientSecret: CLIENT_SECRET as string,
      },
      { timeoutMs: 15_000 },
    );
    const first = session.header();

    const refreshed = await session.refresh();
    expect(refreshed).not.toBe(first);
    expect(await verifySignature(refreshed.replace(/^Bearer /, ""), jwks)).toBe(true);
  }, 30_000);

  it("refuses a wrong client secret without inventing a token", async () => {
    await expect(
      acquireToken(
        resourceUrl,
        {
          grant: "client_credentials",
          clientId: CLIENT_ID as string,
          clientSecret: `${CLIENT_SECRET}-wrong`,
        },
        { timeoutMs: 15_000 },
      ),
    ).rejects.toThrow(/token request/);
  }, 30_000);
});
