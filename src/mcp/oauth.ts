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

import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
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
  /** Scopes to request. Defaults to the challenge, then the PRM's `scopes_supported`. */
  scopes?: string[];
  /** Pre-registered client id. When set with a secret, dynamic registration is skipped. */
  clientId?: string;
  /** Pre-registered client secret. */
  clientSecret?: string;
  /**
   * URL of this client's Client ID Metadata Document. Used as the client id when the
   * server advertises `client_id_metadata_document_supported`, instead of registering.
   */
  clientMetadataUrl?: string;
  /**
   * PEM private key for `private_key_jwt` client authentication (ES256). Required when the
   * server only advertises that method.
   */
  clientPrivateKey?: string;
  /**
   * `authorization_code` (default) is the interactive flow. `client_credentials` is
   * machine-to-machine: no user, no authorization request, no PKCE — a different model, so
   * it has to be chosen deliberately.
   */
  grant?: "authorization_code" | "client_credentials" | "jwt_bearer";
  /**
   * Enterprise managed OAuth (SEP-990), for `grant: "jwt_bearer"`: exchange the operator's
   * IdP ID token for an ID-JAG at `tokenEndpoint`, then present that as the assertion.
   */
  identityProvider?: {
    clientId: string;
    idToken: string;
    /** The IdP issuer. Used to discover the token endpoint when it is not configured. */
    issuer?: string;
    /** The IdP token endpoint (token exchange, RFC 8693). Discovered when omitted. */
    tokenEndpoint?: string;
    /** Audience for the exchange — the MCP authorization server's issuer. */
    audience?: string;
  };
}

/** A live credential for one server: current header, and a way to replace it. */
export interface OAuthSession {
  /** `"Bearer <token>"` — read at request time, so a refresh is picked up immediately. */
  header: () => string;
  /** Ask the token endpoint for a new access token; returns the new header value. */
  refresh: () => Promise<string>;
  /**
   * Re-run the authorization grant with more scopes, for a server that answers `403` with
   * `error="insufficient_scope"`. Returns the new header value.
   */
  escalate: (scopes: string[]) => Promise<string>;
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
  client_id_metadata_document_supported?: boolean;
}

interface RegistrationResponse {
  client_id?: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** A loopback redirect for the headless (`fetch`) flow; any registered URI will do. */
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/oauth/callback";

/** How the token endpoint expects the client to authenticate. */
type TokenAuthMethod = "client_secret_basic" | "client_secret_post" | "private_key_jwt" | "none";

/**
 * Pick the registration response's choice first, then the authorization server's advertised
 * list, then a sensible default. `client_secret_basic` wins over `post` when a secret exists
 * and the server offers both, because the secret stays out of the request body.
 */
function chooseTokenAuthMethod(
  registered: string | undefined,
  clientSecret: string | undefined,
  supported: string[] | undefined,
  hasPrivateKey = false,
): TokenAuthMethod {
  if (
    registered === "client_secret_basic" ||
    registered === "client_secret_post" ||
    registered === "private_key_jwt" ||
    registered === "none"
  ) {
    return registered;
  }
  if (hasPrivateKey && supported?.includes("private_key_jwt")) return "private_key_jwt";
  if (!clientSecret) return "none";
  if (supported?.includes("client_secret_basic")) return "client_secret_basic";
  return "client_secret_post";
}

/** Apply the chosen client authentication to a token request. */
async function applyClientAuth(
  body: URLSearchParams,
  method: TokenAuthMethod,
  clientId: string,
  clientSecret: string | undefined,
  clientPrivateKey: string | undefined,
  audience: string,
): Promise<Record<string, string>> {
  if (method === "client_secret_basic" && clientSecret) {
    const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    return { authorization: `Basic ${encoded}` };
  }
  if (method === "client_secret_post" && clientSecret) body.set("client_secret", clientSecret);
  if (method === "private_key_jwt") {
    if (!clientPrivateKey) {
      throw new Error(
        "OAuth: the server requires private_key_jwt but no private key is configured",
      );
    }
    body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    body.set("client_assertion", privateKeyAssertion(clientId, clientPrivateKey, audience));
  }
  return {};
}

/**
 * A short-lived ES256 assertion (RFC 7523). `iss` and `sub` are the client id because this
 * authenticates the *client*, not a user; `aud` is the authorization server.
 */
export function privateKeyAssertion(
  clientId: string,
  privateKeyPem: string,
  audience: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        iss: clientId,
        sub: clientId,
        aud: audience,
        iat: now,
        exp: now + 300,
        jti: randomUUID(),
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Whether PRM `resource` describes the endpoint we are about to call.
 *
 * Strict equality is too strict in a way that matters: MCP servers publish either the
 * endpoint itself (`https://host/mcp`) or the origin (`https://host`) as the protected
 * resource, and both are the same server. The rule is therefore: same origin, and the
 * resource's path is either the endpoint's path or a prefix of it. A different origin — or
 * a same-origin path that is not a prefix — is a different resource and is refused.
 */
export function sameResource(resource: string, endpoint: string): boolean {
  const parts = (value: string): { origin: string; path: string } => {
    const url = new URL(value);
    return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
  };
  try {
    const left = parts(resource);
    const right = parts(endpoint);
    if (left.origin !== right.origin) return false;
    if (left.path === right.path) return true;
    // The base URL form: the resource names a parent path of the endpoint.
    return left.path === "" || right.path.startsWith(`${left.path}/`);
  } catch {
    return false;
  }
}

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

  // 1. Protected-resource metadata. A 401 that names it is authoritative; otherwise
  // try the RFC 9728 path-based location and then the root. The order matters: a server
  // that publishes both (and traps the root) is answering the challenge, so the
  // fallback only serves servers that advertise the metadata another way.
  const challenged = await challengedMetadataUrl(resourceUrl, fetchImpl);
  // A 2025-03-26-era server may publish no PRM at all. That is not a failure: the origin
  // is then the authorization server, which is the pre-RFC behaviour those deployments
  // expect. The metadata is still used when it exists.
  let prm: ProtectedResourceMetadata | undefined;
  try {
    prm = challenged.metadataUrl
      ? await getJson<ProtectedResourceMetadata>(fetchImpl, challenged.metadataUrl, "PRM metadata")
      : await firstJson<ProtectedResourceMetadata>(
          fetchImpl,
          [protectedResourceUrl(resourceUrl), protectedResourceRootUrl(resourceUrl)],
          "PRM metadata",
        );
  } catch {
    prm = undefined;
  }
  // A PRM that names a *different* resource is not this server's metadata. Issuing a token
  // for it would send the user through an authorization server that has nothing to do with
  // the endpoint being called — the confused-deputy shape RFC 8707 exists to prevent.
  if (prm?.resource && !sameResource(prm.resource, resourceUrl)) {
    throw new Error(
      `OAuth: protected-resource metadata is for "${prm.resource}", not "${resourceUrl}"; ` +
        "refusing to authorize against a different resource",
    );
  }
  const issuer = prm?.authorization_servers?.[0] ?? new URL(resourceUrl).origin;

  // 2. Authorization-server metadata. RFC 8414 puts the well-known segment *before* the
  // issuer's path; OpenID Discovery appends it; both spellings exist in the wild, as do
  // servers publishing only the OIDC document. Try the standard order.
  let as: AuthorizationServerMetadata;
  try {
    as = await firstJson<AuthorizationServerMetadata>(
      fetchImpl,
      authorizationServerMetadataUrls(issuer),
      "authorization-server metadata",
    );
  } catch {
    // The 2025-03-26 fallback: no metadata, so the standard endpoints at the issuer root.
    // Registration is attempted and skipped if the server does not offer it.
    as = {
      issuer,
      authorization_endpoint: `${issuer.replace(/\/+$/, "")}/authorize`,
      token_endpoint: `${issuer.replace(/\/+$/, "")}/token`,
      registration_endpoint: `${issuer.replace(/\/+$/, "")}/register`,
    };
  }
  const tokenEndpoint = as.token_endpoint;
  if (!as.authorization_endpoint || !tokenEndpoint) {
    throw new Error(`OAuth: ${issuer} publishes no usable authorization_endpoint/token_endpoint`);
  }
  log(`[oauth] ${new URL(resourceUrl).host}: authorization server ${as.issuer ?? issuer}`);

  // 3. Dynamic client registration when offered; otherwise the server must accept a
  // public client without one. The *response* decides how the token endpoint wants the
  // client authenticated — a server can register a public client and still require basic.
  let clientId = options.clientId ?? options.clientName ?? "adaptivemcp-agent";
  let clientSecret = options.clientSecret;
  const clientPrivateKey = options.clientPrivateKey;
  let registeredAuthMethod: string | undefined;
  // CIMD (SEP-991): the client's identity is a URL it controls, so no registration step.
  const useCimd =
    !options.clientId &&
    options.clientMetadataUrl !== undefined &&
    as.client_id_metadata_document_supported === true;
  if (useCimd) clientId = options.clientMetadataUrl as string;
  // A pre-registered client is an operator decision: use it and do not ask the server to
  // mint another identity it may not support (the scenario that has no registration
  // endpoint is exactly this case).
  if (!options.clientId && !useCimd && as.registration_endpoint) {
    const registration = await registerOrSkip(fetchImpl, as.registration_endpoint, {
      client_name: options.clientName ?? "Adaptive MCP agent",
      redirect_uris: [options.redirectUri ?? DEFAULT_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    if (!registration.client_id) {
      throw new Error("OAuth: registration response has no client_id");
    }
    clientId = registration.client_id;
    clientSecret = registration.client_secret;
    registeredAuthMethod = registration.token_endpoint_auth_method;
  }
  const tokenAuthMethod = chooseTokenAuthMethod(
    registeredAuthMethod,
    clientSecret,
    as.token_endpoint_auth_methods_supported,
    clientPrivateKey !== undefined,
  );

  // Enterprise managed OAuth (SEP-990): the operator's IdP-issued ID token is exchanged for
  // an ID-JAG, and the ID-JAG is the JWT-bearer assertion the MCP authorization server
  // accepts. Two grants, no browser, no PKCE — and no capability the AS did not advertise.
  if (options.grant === "jwt_bearer") {
    const idp = options.identityProvider;
    if (!idp) {
      throw new Error("OAuth: jwt_bearer needs identityProvider (id token + token endpoint)");
    }
    // The token endpoint is discovered from the provider's OIDC document when the operator
    // has not pinned it. Discovered once per session: a refresh must not re-hit discovery.
    let idpTokenEndpoint = idp.tokenEndpoint;
    const tokenEndpointFor = async (): Promise<string> => {
      if (idpTokenEndpoint) return idpTokenEndpoint;
      if (!idp.issuer) {
        throw new Error(
          "OAuth: jwt_bearer needs identityProvider.tokenEndpoint or identityProvider.issuer",
        );
      }
      const documentUrl = `${idp.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
      const document = await getJson<{ token_endpoint?: string }>(
        fetchImpl,
        documentUrl,
        "identity-provider metadata",
      );
      if (!document.token_endpoint) {
        throw new Error(`OAuth: ${documentUrl} publishes no token_endpoint`);
      }
      idpTokenEndpoint = document.token_endpoint;
      log(`[oauth] ${new URL(resourceUrl).host}: IdP token endpoint discovered`);
      return idpTokenEndpoint;
    };
    if (
      !as.token_endpoint_auth_methods_supported?.includes("client_secret_basic") &&
      !clientSecret
    ) {
      throw new Error(
        "OAuth: jwt_bearer needs a pre-registered client (client id + secret) for the " +
          "authorization server",
      );
    }
    const audience = idp.audience ?? as.issuer ?? issuer;
    const requestToken = async (): Promise<TokenResponse> => {
      const exchange = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: idp.idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        audience,
        resource: resourceUrl,
        client_id: idp.clientId,
      });
      const exchanged = await postForm<{ access_token?: string }>(
        fetchImpl,
        await tokenEndpointFor(),
        exchange,
        "ID token exchange",
      );
      if (!exchanged.access_token) {
        throw new Error("OAuth: the identity provider returned no ID-JAG");
      }
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: exchanged.access_token,
        resource: resourceUrl,
      });
      const headers = await applyClientAuth(
        body,
        tokenAuthMethod,
        clientId,
        clientSecret,
        clientPrivateKey,
        audience,
      );
      return tokenRequest(fetchImpl, tokenEndpoint, body, headers);
    };
    let asserted = await requestToken();
    return {
      header: () => `${asserted.tokenType} ${asserted.accessToken}`,
      refresh: async () => {
        asserted = await requestToken();
        return `${asserted.tokenType} ${asserted.accessToken}`;
      },
      escalate: async () => {
        throw new Error("OAuth: jwt_bearer has no interactive step-up");
      },
      ...(asserted.expiresAt ? { expiresAt: asserted.expiresAt } : {}),
      ...(asserted.scope ? { scope: asserted.scope } : {}),
      issuer: as.issuer ?? issuer,
      clientId,
    };
  }

  // Machine-to-machine: no user, so no authorization request and no PKCE — the token is the
  // whole flow. Deliberately a separate branch rather than a switch inside the interactive
  // one, because mixing the two is how a host accidentally mints a machine token for a
  // person (or the reverse).
  if (options.grant === "client_credentials") {
    if (!options.clientId || (!options.clientSecret && !clientPrivateKey)) {
      throw new Error(
        "OAuth: client_credentials needs a pre-registered client id and secret or private key",
      );
    }
    const audience = as.issuer ?? issuer;
    const requestToken = async (scopes: string[]): Promise<TokenResponse> => {
      const body = new URLSearchParams({ grant_type: "client_credentials", resource: resourceUrl });
      if (scopes.length > 0) body.set("scope", scopes.join(" "));
      const headers = await applyClientAuth(
        body,
        tokenAuthMethod,
        options.clientId as string,
        clientSecret,
        clientPrivateKey,
        audience,
      );
      return tokenRequest(fetchImpl, tokenEndpoint, body, headers);
    };
    const initial = options.scopes ?? (prm?.scopes_supported ? prm.scopes_supported : []);
    let machine = await requestToken(initial);
    return {
      header: () => `${machine.tokenType} ${machine.accessToken}`,
      // No refresh token exists in this grant: a "refresh" is another client_credentials
      // request, which is exactly what the token endpoint expects.
      refresh: async () => {
        machine = await requestToken(initial);
        return `${machine.tokenType} ${machine.accessToken}`;
      },
      escalate: async () => {
        throw new Error("OAuth: client_credentials has no interactive step-up");
      },
      ...(machine.expiresAt ? { expiresAt: machine.expiresAt } : {}),
      ...(machine.scope ? { scope: machine.scope } : {}),
      issuer: as.issuer ?? issuer,
      clientId: options.clientId as string,
    };
  }

  /** One authorization-code grant. Called again, with more scopes, on a step-up. */
  const authorizeOnce = async (scopes: string[]): Promise<TokenResponse> => {
    const callback = mode === "browser" ? await startCallback(timeoutMs) : undefined;
    try {
      const redirectUri = options.redirectUri ?? callback?.redirectUri ?? DEFAULT_REDIRECT_URI;
      const verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      const state = base64url(randomBytes(16));
      const authorizeUrl = new URL(as.authorization_endpoint as string);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("resource", resourceUrl);
      if (scopes.length > 0) authorizeUrl.searchParams.set("scope", scopes.join(" "));

      const { code, state: returnedState } =
        mode === "browser"
          ? await browserAuthorization(authorizeUrl, callback!, log)
          : await fetchAuthorization(fetchImpl, authorizeUrl, log);
      if (returnedState !== state) {
        throw new Error("OAuth: authorization response state does not match the request");
      }

      // `resource` is repeated so the token is bound to this server.
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: resourceUrl,
      });
      const headers = await applyClientAuth(
        body,
        tokenAuthMethod,
        clientId,
        clientSecret,
        clientPrivateKey,
        as.issuer ?? issuer,
      );
      return tokenRequest(fetchImpl, tokenEndpoint, body, headers);
    } finally {
      callback?.close();
    }
  };

  const initialScopes =
    options.scopes ??
    (challenged.scope ? challenged.scope.split(/\s+/).filter(Boolean) : undefined) ??
    prm?.scopes_supported ??
    [];
  let current = await authorizeOnce(initialScopes);

  return {
    header: () => `${current.tokenType} ${current.accessToken}`,
    refresh: async () => {
      if (!current.refreshToken) {
        throw new Error("OAuth: the token response carried no refresh_token");
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: clientId,
        resource: resourceUrl,
      });
      const headers = await applyClientAuth(
        body,
        tokenAuthMethod,
        clientId,
        clientSecret,
        clientPrivateKey,
        as.issuer ?? issuer,
      );
      const refreshed = await tokenRequest(fetchImpl, tokenEndpoint, body, headers);
      // A refresh response may omit `refresh_token`; keep the one that still works.
      current = { ...refreshed, refreshToken: refreshed.refreshToken ?? current.refreshToken };
      return `${current.tokenType} ${current.accessToken}`;
    },
    escalate: async (scopes: string[]) => {
      log(`[oauth] ${new URL(resourceUrl).host}: escalating scopes to ${scopes.join(" ")}`);
      current = await authorizeOnce(scopes);
      return `${current.tokenType} ${current.accessToken}`;
    },
    ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
    ...(current.scope ? { scope: current.scope } : {}),
    issuer: as.issuer ?? issuer,
    clientId,
  };
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

/** What a 401 challenge told us: where the metadata is, and which scopes it wants. */
interface Challenge {
  metadataUrl?: string;
  scope?: string;
}

/** Read `resource_metadata` and `scope` from a 401 challenge. */
async function challengedMetadataUrl(
  resourceUrl: string,
  fetchImpl: typeof fetch,
): Promise<Challenge> {
  try {
    const response = await fetchImpl(resourceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    if (response.status !== 401) return {};
    return parseChallenge(response.headers.get("www-authenticate") ?? "");
  } catch {
    // A probe that cannot connect is not fatal here: the MCP transport will report the
    // real problem. Fall through to the derived location.
    return {};
  }
}

/** Parse `resource_metadata` and `scope` out of a `WWW-Authenticate: Bearer …` value. */
export function parseChallenge(header: string): Challenge {
  const metadata =
    /resource_metadata="([^"]+)"/i.exec(header) ?? /resource_metadata=([^,\s]+)/i.exec(header);
  const scope = /(?:^|[,\s])scope="([^"]*)"/i.exec(header);
  return {
    ...(metadata?.[1] ? { metadataUrl: metadata[1] } : {}),
    ...(scope?.[1] ? { scope: scope[1] } : {}),
  };
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
  headers: Record<string, string> = {},
): Promise<TokenResponse> {
  const token = await postForm<{
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }>(fetchImpl, tokenEndpoint, body, "token request", headers);
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

/**
 * Dynamic registration, tolerating a server that advertises no registration at all.
 *
 * A 404 means "register somewhere else"; the client falls back to a public identity instead
 * of failing the whole login, which is what an operator on such a server wants.
 */
async function registerOrSkip(
  fetchImpl: typeof fetch,
  url: string,
  payload: unknown,
): Promise<RegistrationResponse> {
  try {
    return await postJson<RegistrationResponse>(fetchImpl, url, payload, "client registration");
  } catch (error) {
    if (error instanceof Error && /returned 404/.test(error.message)) return {};
    throw error;
  }
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
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...extraHeaders,
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
