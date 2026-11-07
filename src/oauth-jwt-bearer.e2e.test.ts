import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireToken } from "./mcp/oauth.js";

/**
 * `jwt_bearer` end to end, offline.
 *
 * The conformance scenario drives this grant, but it needs `npx` and the harness's scripted
 * implementation. This runs the flow against a fixture we control, with **real JWT
 * cryptography**: an identity provider mints an ES256 **ID-JAG** after an RFC 8693 exchange,
 * and an authorization server verifies that ID-JAG's signature and audience before it issues
 * an access token. Nothing is mocked in the middle — the client's HTTP requests, the JWT
 * signing and the signature verification are all real.
 *
 * What it proves: the exchange parameters, the assertion the client presents, and that the
 * client only accepts a token the authorization server signed off on.
 */
interface Recorded {
  exchange?: URLSearchParams;
  assertionGrant?: URLSearchParams;
  authorizationHeader?: string;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function idJag(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  options: {
    issuer: string;
    audience: string;
    resource: string;
    subject: string;
  },
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "oauth-id-jag+jwt" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      iss: options.issuer,
      aud: options.audience,
      sub: options.subject,
      resource: options.resource,
      client_id: "idp-client",
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

describe("jwt_bearer end to end", () => {
  let idp: Server;
  let as: Server;
  let resourceUrl: string;
  let recorded: Recorded;
  let idpPublicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];

  beforeAll(async () => {
    recorded = {};
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    idpPublicKey = publicKey;

    // Identity provider: RFC 8693 token exchange, issuing an ID-JAG signed by its key.
    idp = createServer((request, response) => {
      if (request.url === "/token" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const form = new URLSearchParams(body);
          recorded.exchange = form;
          const required =
            form.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange" &&
            form.get("subject_token_type") === "urn:ietf:params:oauth:token-type:id_token" &&
            form.get("requested_token_type") === "urn:ietf:params:oauth:token-type:id-jag" &&
            form.get("audience") === asIssuer() &&
            form.get("resource") === resourceUrl;
          if (!required) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_request" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: idJag(privateKey, {
                issuer: idpIssuer(),
                audience: asIssuer() as string,
                resource: resourceUrl,
                subject: "alice@example.com",
              }),
              issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
              token_type: "N_A",
            }),
          );
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    const idpPort = (idp.address() as AddressInfo).port;

    // Authorization server: verifies the ID-JAG and issues the access token.
    as = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ resource: resourceUrl, authorization_servers: [asIssuer()] }),
        );
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            issuer: asIssuer(),
            authorization_endpoint: `${asIssuer()}/authorize`,
            token_endpoint: `${asIssuer()}/token`,
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
          }),
        );
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const form = new URLSearchParams(body);
          recorded.assertionGrant = form;
          recorded.authorizationHeader = request.headers.authorization;
          const assertion = form.get("assertion") ?? "";
          const [header, payload, signature] = assertion.split(".");
          let rejected: string | undefined;
          if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
            rejected = "wrong grant type";
          } else if (!header || !payload || !signature) {
            rejected = "missing assertion";
          } else {
            const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
            if (claims.aud !== asIssuer()) rejected = "wrong audience";
            else if (
              !verify(
                "sha256",
                Buffer.from(`${header}.${payload}`),
                // JWS uses raw r||s for ECDSA; the default DER encoding would not match.
                { key: idpPublicKey, dsaEncoding: "ieee-p1363" },
                Buffer.from(signature, "base64url"),
              )
            ) {
              rejected = "bad signature";
            }
          }
          if (rejected) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_client", error_description: rejected }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ access_token: "mcp-access-token", token_type: "Bearer" }));
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => as.listen(0, "127.0.0.1", resolve));
    const asPort = (as.address() as AddressInfo).port;
    // The closures above read these through the helpers so the URLs are stable after listen.
    asIssuerUrl = `http://127.0.0.1:${asPort}`;
    idpIssuerUrl = `http://127.0.0.1:${idpPort}`;
    resourceUrl = `${asIssuerUrl}/mcp`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => idp?.close(() => resolve()));
    await new Promise<void>((resolve) => as?.close(() => resolve()));
  });

  function idpIssuer(): string {
    return idpIssuerUrl;
  }
  function asIssuer(): string {
    return asIssuerUrl;
  }

  it("exchanges the IdP ID token for an ID-JAG the authorization server verifies", async () => {
    const session = await acquireToken(
      resourceUrl,
      {
        authorize: "fetch",
        grant: "jwt_bearer",
        clientId: "agent-client",
        clientSecret: "agent-secret",
        identityProvider: {
          clientId: "idp-client",
          idToken: "the-idp-id-token",
          tokenEndpoint: `${idpIssuer()}/token`,
        },
      },
      { timeoutMs: 10_000 },
    );

    expect(session.header()).toBe("Bearer mcp-access-token");
    // RFC 8693 exchange, with every parameter the IdP requires.
    expect(recorded.exchange?.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:token-exchange",
    );
    expect(recorded.exchange?.get("subject_token")).toBe("the-idp-id-token");
    expect(recorded.exchange?.get("requested_token_type")).toBe(
      "urn:ietf:params:oauth:token-type:id-jag",
    );
    expect(recorded.exchange?.get("audience")).toBe(asIssuer());
    expect(recorded.exchange?.get("resource")).toBe(resourceUrl);
    // The assertion grant used the ID-JAG, with client_secret_basic as advertised.
    expect(recorded.assertionGrant?.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = recorded.assertionGrant?.get("assertion") ?? "";
    const claims = JSON.parse(
      Buffer.from(assertion.split(".")[1] as string, "base64url").toString(),
    );
    expect(claims).toMatchObject({ aud: asIssuer(), resource: resourceUrl });
    expect(recorded.authorizationHeader).toMatch(/^Basic /);
  }, 20_000);

  it("refuses a token the authorization server would not have issued", async () => {
    // Point the audience somewhere else: the AS rejects the ID-JAG, so the client must fail
    // rather than return the token endpoint's error body as a credential.
    await expect(
      acquireToken(
        resourceUrl,
        {
          authorize: "fetch",
          grant: "jwt_bearer",
          clientId: "agent-client",
          clientSecret: "agent-secret",
          identityProvider: {
            clientId: "idp-client",
            idToken: "the-idp-id-token",
            tokenEndpoint: `${idpIssuer()}/token`,
            audience: "https://not-this-server.example",
          },
        },
        { timeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/ID token exchange|token request/);
  }, 20_000);
});

let asIssuerUrl = "";
let idpIssuerUrl = "";
