import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireToken } from "./mcp/oauth.js";

/**
 * The authorization-code grant against a **real** provider, headlessly.
 *
 * The conformance harness drives this grant, but with a scripted server: it proves the shape
 * of PKCE and the token exchange, not that our client interoperates with a provider that
 * authenticates a person. This test fronts a real provider (Keycloak in the recorded run)
 * with a login helper: the helper drives the provider's login form, so the agent's own
 * `authorize: "fetch"` request can complete without a browser.
 *
 * Skipped unless the environment names a provider, a **public** authorization-code client and
 * a user:
 *
 *   AGENT_OIDC_ISSUER        e.g. http://127.0.0.1:8091/realms/agent-ac
 *   AGENT_OIDC_CLIENT_ID     public client with redirect http://127.0.0.1:8765/oauth/callback
 *   AGENT_OIDC_USERNAME / AGENT_OIDC_PASSWORD
 *   AGENT_OIDC_SCOPE         optional scope to request
 *
 * See `docs/conformance-client.md` for the measured run.
 */
const ISSUER = process.env.AGENT_OIDC_ISSUER;
const CLIENT_ID = process.env.AGENT_OIDC_CLIENT_ID;
const USERNAME = process.env.AGENT_OIDC_USERNAME;
const PASSWORD = process.env.AGENT_OIDC_PASSWORD;
const SCOPE = process.env.AGENT_OIDC_SCOPE;
const live = Boolean(ISSUER && CLIENT_ID && USERNAME && PASSWORD);

const REDIRECT_URI = "http://127.0.0.1:8765/oauth/callback";

interface CookieJar {
  header: () => string;
  absorb: (response: Response) => void;
}

function cookieJar(): CookieJar {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    absorb: (response) => {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0];
        if (pair === undefined) continue;
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
  };
}

interface AuthorizeQuery {
  code_challenge?: string;
  code_challenge_method?: string;
  response_type?: string;
  scope?: string;
}

/**
 * Drive the provider's login form and return the redirect that carries the code.
 *
 * Two shapes exist: a redirect to a login route, or the login page served directly (Keycloak
 * does the latter once `resource` is among the parameters).
 */
async function login(
  authorizeUrl: string,
  redirectUri: string,
  username: string,
  password: string,
): Promise<string> {
  const cookies = cookieJar();
  let url = authorizeUrl;
  for (let hop = 0; hop < 12; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: cookies.header() ? { cookie: cookies.header() } : {},
    });
    cookies.absorb(response);
    const location = response.headers.get("location");
    if (!location && response.status === 200) {
      const html = await response.text();
      const action = /<form[^>]*action="([^"]+)"/i.exec(html)?.[1];
      if (!action) throw new Error(`login page without a form at ${url}`);
      const form = new URLSearchParams();
      for (const [, name, value] of html.matchAll(
        /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi,
      )) {
        form.set(name as string, value as string);
      }
      form.set("username", username);
      form.set("password", password);
      form.set("credentialId", "");
      const signed = await fetch(new URL((action as string).replaceAll("&amp;", "&"), url), {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(cookies.header() ? { cookie: cookies.header() } : {}),
        },
        body: form.toString(),
      });
      cookies.absorb(signed);
      const after = signed.headers.get("location");
      if (!after) throw new Error(`login POST did not redirect (${signed.status})`);
      const resolved = new URL(after, url);
      if (resolved.toString().startsWith(redirectUri)) return resolved.toString();
      url = resolved.toString();
      continue;
    }
    if (!location) throw new Error(`no redirect at ${url} (${response.status})`);
    const next = new URL(location, url);
    if (next.toString().startsWith(redirectUri)) return next.toString();
    url = next.toString();
  }
  throw new Error("login did not reach the redirect_uri");
}

describe.skipIf(!live)("authorization_code against a real identity provider", () => {
  let loginProxy: Server;
  let prm: Server;
  let providerBase: string;
  let resourceUrl: string;
  let authorizeQuery: AuthorizeQuery = {};

  beforeAll(async () => {
    // The login helper is the provider's front door: our client discovers *this* issuer, and
    // authorize/token are proxied to the real one. Token issuance, PKCE verification and the
    // JWKS all remain the provider's.
    loginProxy = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            issuer: providerBase,
            authorization_endpoint: `${providerBase}/authorize`,
            token_endpoint: `${providerBase}/token`,
            jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          }),
        );
        return;
      }
      if (url.pathname === "/authorize") {
        authorizeQuery = {
          code_challenge: url.searchParams.get("code_challenge") ?? undefined,
          code_challenge_method: url.searchParams.get("code_challenge_method") ?? undefined,
          response_type: url.searchParams.get("response_type") ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
        };
        const target = new URL(`${ISSUER}/protocol/openid-connect/auth`);
        for (const [key, value] of url.searchParams) target.searchParams.set(key, value);
        void login(
          target.toString(),
          url.searchParams.get("redirect_uri") ?? REDIRECT_URI,
          USERNAME as string,
          PASSWORD as string,
        )
          .then((final) => response.writeHead(302, { location: final }).end())
          .catch((error: unknown) => {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end(String(error));
          });
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          void fetch(`${ISSUER}/protocol/openid-connect/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          })
            .then(async (upstream) => {
              response.writeHead(upstream.status, { "content-type": "application/json" });
              response.end(await upstream.text());
            })
            .catch((error: unknown) => {
              response.writeHead(502, { "content-type": "text/plain" });
              response.end(String(error));
            });
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => loginProxy.listen(0, "127.0.0.1", resolve));
    providerBase = `http://127.0.0.1:${(loginProxy.address() as AddressInfo).port}`;

    // A real MCP server publishes protected-resource metadata; the provider does not.
    prm = createServer((request, response) => {
      if (request.url?.startsWith("/.well-known/oauth-protected-resource")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ resource: resourceUrl, authorization_servers: [providerBase] }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => prm.listen(0, "127.0.0.1", resolve));
    resourceUrl = `http://127.0.0.1:${(prm.address() as AddressInfo).port}/mcp`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => loginProxy?.close(() => resolve()));
    await new Promise<void>((resolve) => prm?.close(() => resolve()));
  });

  it("completes a PKCE login and gets a token the provider issued", async () => {
    const session = await acquireToken(
      resourceUrl,
      {
        authorize: "fetch",
        clientId: CLIENT_ID as string,
        redirectUri: REDIRECT_URI,
        ...(SCOPE ? { scopes: [SCOPE] } : {}),
      },
      { timeoutMs: 20_000 },
    );

    const token = session.header().replace(/^Bearer /, "");
    const claims = JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString());
    expect(claims.iss).toBe(ISSUER);
    // PKCE is what the provider verified: S256 with a real challenge, not a plain verifier.
    expect(authorizeQuery.response_type).toBe("code");
    expect(authorizeQuery.code_challenge_method).toBe("S256");
    expect(authorizeQuery.code_challenge?.length ?? 0).toBeGreaterThan(42);
    if (SCOPE) expect(authorizeQuery.scope ?? "").toContain(SCOPE);
  }, 30_000);

  it("refreshes and the provider issues a different access token", async () => {
    const session = await acquireToken(
      resourceUrl,
      {
        authorize: "fetch",
        clientId: CLIENT_ID as string,
        redirectUri: REDIRECT_URI,
      },
      { timeoutMs: 20_000 },
    );
    const first = session.header();

    const refreshed = await session.refresh();

    expect(refreshed).not.toBe(first);
    const claims = JSON.parse(
      Buffer.from(
        refreshed.replace(/^Bearer /, "").split(".")[1] as string,
        "base64url",
      ).toString(),
    );
    expect(claims.iss).toBe(ISSUER);
    expect(claims.jti).not.toBe(
      JSON.parse(
        Buffer.from(first.replace(/^Bearer /, "").split(".")[1] as string, "base64url").toString(),
      ).jti,
    );
  }, 30_000);
});
