/**
 * OAuth 2.1 client for a remote MCP server (MCP 2025-11-25 authorization).
 *
 * This is the *discovery* half plus the authorization-code grant. It exists because a
 * 401 from a remote server is not an error to report, it is an instruction: find the
 * protected-resource metadata, find the authorization server, register (dynamically if
 * the server allows it), and get a token.
 *
 * Deliberately narrow:
 * - **PKCE S256 always.** No client secret is trusted for the code exchange; a server
 *   that offers one is still sent the verifier.
 * - **The resource is named.** The RFC 8707 `resource` parameter is sent on both the
 *   authorization and token requests, so a token issued here cannot be replayed against
 *   a different MCP server by a confused deputy.
 * - **No token is logged.** Only the issuer and the client id reach the operator.
 * - **Refresh is not implemented yet.** A token is acquired for the run; expiry inside a
 *   long session is a known gap, recorded in `docs/conformance-client.md`.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** How the authorization request is delivered to a human or a driver. */
export type AuthorizationMode = "browser" | "fetch";

export interface OAuthOptions {
  /**
   * `browser` (default) starts a loopback listener, prints the URL, and waits for the
   * redirect a browser makes. `fetch` performs the redirect itself — for a headless
   * driver such as the conformance adapter, where no human is present.
   */
  authorize?: AuthorizationMode;
  /** Override the redirect URI. Defaults to the loopback callback, or a fixed local one. */
  redirectUri?: string;
  /** Names the client at the registration endpoint. */
  clientName?: string;
  /** Scopes to request. Empty means "whatever the server offers". */
  scopes?: string[];
}

/** A live credential for one server: current header, and a way to replace it. */
export interface OAuthSession {
  /** `"Bearer <token>"` — read at request time, so a refresh is picked up immediately. */
  header: () => string;
  /** Ask the token endpoint for a new access token; returns the new header value. */
  refresh: () => Promise<string>;
  /** Unix milliseconds, when the server returned `expires_in`. */
  expiresAt?: number;
  scope?: string;
  /** Where the token came from, for the run summary — never the token itself. */
  issuer: string;
  clientId: string;
}

export interface OAuthDependencies {
  fetch?: typeof fetch;
  /** Progress lines (URL to open, issuer found). Never receives a token. */
  log?: (message: string) => void;
  /** Authorization timeout in milliseconds. */
  timeoutMs?: number;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

interface RegistrationResponse {
  client_id?: string;
  client_secret?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** A loopback callback URL, and the code it is waiting for. */
interface Callback {
  redirectUri: string;
  /** Resolves with `{ code, state }`; rejects on timeout or an error response. */
  wait: Promise<{ code: string; state: string | null }>;
  close: () => void;
}

/**
 * Acquire an access token for one MCP server.
 *
 * Throws with an actionable message at the first step that fails; the CLI turns that into
 * a config error rather than a half-authenticated session.
 */
export async function acquireToken(
  resourceUrl: string,
  options: OAuthOptions = {},
  deps: OAuthDependencies = {},
): Promise<OAuthSession> {
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const mode = options.authorize ?? "browser";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const callback = mode === "browser" ? await startCallback(timeoutMs) : undefined;
  try {
    const redirectUri =
      options.redirectUri ?? callback?.redirectUri ?? "http://127.0.0.1:8765/oauth/callback";

    // 1. Protected-resource metadata. A 401 that names it is authoritative; otherwise
    // try the RFC 9728 path-based location and then the root. The order matters: a server
    // that publishes both (and traps the root) is answering the challenge, so the
    // fallback only serves servers that advertise the metadata another way.
    const challenged = await challengedMetadataUrl(resourceUrl, fetchImpl);
    const prm = challenged
      ? await getJson<ProtectedResourceMetadata>(fetchImpl, challenged, "PRM metadata")
      : await firstJson<ProtectedResourceMetadata>(
          fetchImpl,
          [protectedResourceUrl(resourceUrl), protectedResourceRootUrl(resourceUrl)],
          "PRM metadata",
        );
    const issuer = prm.authorization_servers?.[0];
    if (!issuer) {
      throw new Error("OAuth: protected-resource metadata lists no authorization_servers");
    }

    // 2. Authorization-server metadata. RFC 8414 puts the well-known segment *before* the
    // issuer's path; OpenID Discovery appends it; both spellings exist in the wild, as do
    // servers publishing only the OIDC document. Try the standard order.
    const as = await firstJson<AuthorizationServerMetadata>(
      fetchImpl,
      authorizationServerMetadataUrls(issuer),
      "authorization-server metadata",
    );
    if (!as.authorization_endpoint || !as.token_endpoint) {
      throw new Error(`OAuth: ${issuer} publishes no usable authorization_endpoint/token_endpoint`);
    }
    log(`[oauth] ${new URL(resourceUrl).host}: authorization server ${as.issuer ?? issuer}`);

    // 3. Dynamic client registration when offered; otherwise the server must accept a
    // public client without one.
    let clientId = options.clientName ?? "adaptivemcp-agent";
    let clientSecret: string | undefined;
    if (as.registration_endpoint) {
      const registration = await postJson<RegistrationResponse>(
        fetchImpl,
        as.registration_endpoint,
        {
          client_name: options.clientName ?? "Adaptive MCP agent",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        "client registration",
      );
      if (!registration.client_id) {
        throw new Error("OAuth: registration response has no client_id");
      }
      clientId = registration.client_id;
      clientSecret = registration.client_secret;
    }

    // 4. Authorization request with PKCE S256.
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("resource", resourceUrl);
    const scopes = options.scopes ?? [];
    if (scopes.length > 0) authorizeUrl.searchParams.set("scope", scopes.join(" "));

    const { code, state: returnedState } =
      mode === "browser"
        ? await browserAuthorization(authorizeUrl, callback!, log)
        : await fetchAuthorization(fetchImpl, authorizeUrl, log);
    if (returnedState !== state) {
      throw new Error("OAuth: authorization response state does not match the request");
    }

    // 5. Token request. `resource` is repeated so the token is bound to this server.
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: resourceUrl,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const issued = await tokenRequest(fetchImpl, as.token_endpoint, body);

    let current = issued;
    return {
      header: () => `${current.tokenType} ${current.accessToken}`,
      refresh: async () => {
        if (!current.refreshToken) {
          throw new Error("OAuth: the token response carried no refresh_token");
        }
        const refreshBody = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: clientId,
          resource: resourceUrl,
        });
        if (clientSecret) refreshBody.set("client_secret", clientSecret);
        const refreshed = await tokenRequest(fetchImpl, as.token_endpoint as string, refreshBody);
        // A refresh response may omit `refresh_token`; keep the one that still works.
        current = { ...refreshed, refreshToken: refreshed.refreshToken ?? current.refreshToken };
        return `${current.tokenType} ${current.accessToken}`;
      },
      ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
      ...(issued.scope ? { scope: issued.scope } : {}),
      issuer: as.issuer ?? issuer,
      clientId,
    };
  } finally {
    callback?.close();
  }
}

/** `https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp`. */
export function protectedResourceUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/^\/+/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path ? `/${path}` : ""}`;
}

/**
 * RFC 8414: `https://host/tenant1` → `https://host/.well-known/oauth-authorization-server/tenant1`.
 * The well-known segment goes *before* the issuer's path, not after it.
 */
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path ? `/${path}` : ""}`;
}

/**
 * Every location worth trying for authorization-server metadata, most standard first:
 *
 * 1. RFC 8414 with the issuer's path after the well-known segment;
 * 2. OpenID Discovery in the same shape;
 * 3. both spellings appended to the issuer (the pre-RFC form, and what the tenant
 *    deployment in `auth/metadata-var3` publishes).
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  const suffix = path ? `/${path}` : "";
  const bare = issuer.replace(/\/+$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${url.origin}/.well-known/openid-configuration${suffix}`,
    `${bare}/.well-known/openid-configuration`,
    `${bare}/.well-known/oauth-authorization-server`,
  ];
}

/** The root protected-resource location (RFC 9728 origin-level form). */
export function protectedResourceRootUrl(resourceUrl: string): string {
  return `${new URL(resourceUrl).origin}/.well-known/oauth-protected-resource`;
}

/** First URL that answers `2xx` with JSON wins; otherwise the last error is thrown. */
async function firstJson<T>(fetchImpl: typeof fetch, urls: string[], what: string): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await getJson<T>(fetchImpl, url, what);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`OAuth: no ${what} found at ${urls.join(", ")}`);
}

/** Read `resource_metadata` from a 401 challenge, if the server offers one. */
async function challengedMetadataUrl(
  resourceUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(resourceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    if (response.status !== 401) return undefined;
    const header = response.headers.get("www-authenticate") ?? "";
    const match =
      /resource_metadata="([^"]+)"/i.exec(header) ?? /resource_metadata=([^,\s]+)/i.exec(header);
    return match?.[1];
  } catch {
    // A probe that cannot connect is not fatal here: the MCP transport will report the
    // real problem. Fall through to the derived location.
    return undefined;
  }
}

async function browserAuthorization(
  authorizeUrl: URL,
  callback: Callback,
  log: (message: string) => void,
): Promise<{ code: string; state: string | null }> {
  log(`[oauth] open this URL to authorize:\n${authorizeUrl.toString()}`);
  // Some environments have an opener; none is required. The callback server is the
  // contract, so a headless box can still be driven by pasting the URL elsewhere.
  const { spawn } = await import("node:child_process");
  const opener = process.env.AGENT_OAUTH_OPENER;
  if (opener) {
    spawn(opener, [authorizeUrl.toString()], { stdio: "ignore", detached: true }).unref();
  }
  return callback.wait;
}

async function fetchAuthorization(
  fetchImpl: typeof fetch,
  authorizeUrl: URL,
  log: (message: string) => void,
): Promise<{ code: string; state: string | null }> {
  log(`[oauth] fetching the authorization URL (headless) ${authorizeUrl.origin}`);
  const response = await fetchImpl(authorizeUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`OAuth: authorization endpoint returned ${response.status} without a redirect`);
  }
  const redirect = new URL(location, authorizeUrl);
  const code = redirect.searchParams.get("code");
  const error = redirect.searchParams.get("error");
  if (error) {
    throw new Error(
      `OAuth: authorization failed: ${error}` +
        (redirect.searchParams.get("error_description")
          ? ` (${redirect.searchParams.get("error_description")})`
          : ""),
    );
  }
  if (!code) throw new Error("OAuth: authorization redirect carried no code");
  return { code, state: redirect.searchParams.get("state") };
}

/** A loopback listener that resolves with the first authorization-code redirect. */
async function startCallback(timeoutMs: number): Promise<Callback> {
  let resolveWait: (value: { code: string; state: string | null }) => void = () => {};
  let rejectWait: (reason: Error) => void = () => {};
  const wait = new Promise<{ code: string; state: string | null }>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      code ? "Authorization complete. You can close this window." : "Authorization failed.",
    );
    if (error) {
      rejectWait(new Error(`OAuth: authorization failed: ${error}`));
      return;
    }
    if (!code) {
      rejectWait(new Error("OAuth: callback carried no code"));
      return;
    }
    resolveWait({ code, state: url.searchParams.get("state") });
  });

  const timer = setTimeout(
    () => rejectWait(new Error(`OAuth: no authorization within ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  timer.unref();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
    wait,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

interface TokenResponse {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

/** Exchange a code or a refresh token at the token endpoint. */
async function tokenRequest(
  fetchImpl: typeof fetch,
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const token = await postForm<{
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }>(fetchImpl, tokenEndpoint, body, "token request");
  if (!token.access_token) {
    throw new Error("OAuth: token response has no access_token");
  }
  return {
    accessToken: token.access_token,
    tokenType: token.token_type ?? "Bearer",
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
    ...(token.scope ? { scope: token.scope } : {}),
  };
}

async function getJson<T>(fetchImpl: typeof fetch, url: string, what: string): Promise<T> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`OAuth: ${what} at ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  payload: unknown,
  what: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`OAuth: ${what} at ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postForm<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
  what: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`OAuth: ${what} at ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
