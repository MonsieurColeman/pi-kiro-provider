import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";

import type { KiroAuthMethod, KiroOAuthConfig } from "./config.js";
import { redactSensitiveString } from "./debug-logger.js";
import { applyDiscoveredModels, withDiscoveredCatalog, type ModelDiscoveryConfig } from "./discovery.js";
import type { DebugLogger } from "./debug-logger.js";
import { isRecord, nonEmptyString, type JsonRecord, positiveFiniteNumber as numericSeconds, KIRO_PROFILE_ARN_HEADER, readJsonResponse, applyProfileArnToModels, resolveOAuthProviderIdentity } from "./shared/index.js";

interface KiroCredentials extends OAuthCredentials {
  clientId?: string;
  clientSecret?: string;
  region?: string;
  profileArn?: string;
  authMethod?: KiroAuthMethod | string;
  provider?: string;
}

export type KiroOAuthFlow = "login" | "refresh";

export interface KiroOAuthFailureDetails {
  providerId: string;
  flow: KiroOAuthFlow;
  status?: number;
  errorCode?: string;
  reason: "missing_refresh_token" | "missing_client_metadata" | "missing_required_fields" | "unsupported_auth_method" | "invalid_callback" | "state_mismatch" | "token_rejected" | "authorization_denied" | "device_code_expired" | "client_rejected" | "rate_limited" | "http_error" | "request_failed";
  permanent: boolean;
  retryable: boolean;
  source: "extension";
}

export class KiroOAuthFailureError extends Error {
  readonly details: KiroOAuthFailureDetails;
  readonly kiroOAuth: KiroOAuthFailureDetails;

  constructor(message: string, details: KiroOAuthFailureDetails, options?: { cause?: unknown }) {
    super(redactSensitiveString(message), options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = details.flow === "refresh" ? "OAuthRefreshFailureError" : "KiroOAuthFailureError";
    this.details = { ...details };
    this.kiroOAuth = { ...details };
  }
}

const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 3600;
const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 300_000;
const AUTH_METHODS = ["builder-id", "google", "github"] as const satisfies readonly KiroAuthMethod[];
const SOCIAL_AUTH_METHODS = ["google", "github"] as const satisfies readonly KiroAuthMethod[];
const SOCIAL_IDP_BY_METHOD: Record<(typeof SOCIAL_AUTH_METHODS)[number], string> = {
  google: "Google",
  github: "Github",
};
const PKCE_VERIFIER_BYTES = 32;
const PORTAL_METHOD = "portal";
const PORTAL_PORT = 3128;
const PORTAL_REDIRECT_URI = `http://localhost:${PORTAL_PORT}`;
const PORTAL_CALLBACK_PATHS = ["/", "/oauth/callback", "/signin/callback"];
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const DEFAULT_SOCIAL_PORTAL_URL = "https://app.kiro.dev/signin";
const DEFAULT_SOCIAL_PORTAL_REDIRECT_URI = "http://localhost:3128";
const DEFAULT_SOCIAL_CALLBACK_PATH = "/oauth/callback";
const DEFAULT_SOCIAL_CALLBACK_PORT_SPAN = 20;
const LOCAL_CALLBACK_SUCCESS_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Kiro authentication complete</title></head><body><h1>Kiro authentication complete</h1><p>You can return to Pi.</p></body></html>";
const LOCAL_CALLBACK_ERROR_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Kiro authentication failed</title></head><body><h1>Kiro authentication failed</h1><p>Return to Pi and paste the callback URL manually.</p></body></html>";

interface LocalCallbackServerHandle {
  redirectBaseUri: string;
  callbackUrl: string;
  waitForCallback(): Promise<string | null>;
  cancelWait(): void;
  close(): Promise<void>;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function configString(config: KiroOAuthConfig, key: keyof KiroOAuthConfig, fallback: string): string {
  return nonEmptyString(config[key]) ?? fallback;
}

function responseString(body: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(body[key]);
    if (value) return value;
  }
  return undefined;
}

function tokenExpiresAt(body: JsonRecord): number {
  const explicitExpiresAt = responseString(body, "expiresAt", "expires_at");
  if (explicitExpiresAt) {
    const parsed = Date.parse(explicitExpiresAt);
    if (Number.isFinite(parsed) && parsed > Date.now()) return parsed;
  }
  return expiresAt(body.expiresIn ?? body.expires_in);
}

function isKiroAuthMethod(value: unknown): value is KiroAuthMethod {
  return typeof value === "string" && AUTH_METHODS.includes(value as KiroAuthMethod);
}

function normalizeStoredAuthMethod(value: unknown): KiroAuthMethod | undefined {
  if (value === undefined || value === null || value === "") return "builder-id";
  return isKiroAuthMethod(value) ? value : undefined;
}

function base64UrlRandom(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function createPkce(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = base64UrlRandom(PKCE_VERIFIER_BYTES);
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    state: base64UrlRandom(PKCE_VERIFIER_BYTES),
  };
}

function endpoint(region: string, path: string): string {
  return `https://oidc.${region}.amazonaws.com/${path.replace(/^\/+/, "")}`;
}

function oauthRequestTimeoutMs(config?: Pick<KiroOAuthConfig, "requestTimeoutMs">): number {
  const configuredTimeout = config?.requestTimeoutMs;
  return typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : DEFAULT_OAUTH_REQUEST_TIMEOUT_MS;
}

async function fetchOAuthWithTimeout(input: RequestInfo | URL, init: RequestInit, config?: Pick<KiroOAuthConfig, "requestTimeoutMs">): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), oauthRequestTimeoutMs(config));
  (timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const OIDC_JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
const SOCIAL_JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Kiro-CLI" };
const OAUTH_NON_OBJECT_MESSAGE = "Kiro OAuth returned a non-object JSON response.";

type OAuthFailureFactory = (input: {
  cause?: unknown;
  status?: number;
  body?: JsonRecord;
  reason?: KiroOAuthFailureDetails["reason"];
  permanent?: boolean;
}) => KiroOAuthFailureError;

async function postJson(
  config: Pick<KiroOAuthConfig, "requestTimeoutMs"> | undefined,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  failure: OAuthFailureFactory,
  acceptBody?: (body: JsonRecord, response: Response) => boolean,
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetchOAuthWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, config);
  } catch (error) {
    throw failure({ cause: error, reason: "request_failed", permanent: false });
  }
  const body = await readJsonResponse(response, OAUTH_NON_OBJECT_MESSAGE);
  const accepted = acceptBody ? acceptBody(body, response) : response.ok;
  if (!accepted) throw failure({ status: response.status, body });
  return body;
}

function oauthErrorParts(body: JsonRecord | undefined): { code?: string; description?: string } {
  const nested = isRecord(body?.error) ? body.error : undefined;
  return {
    code: nonEmptyString(body?.error) ?? nonEmptyString(nested?.code) ?? nonEmptyString(nested?.type),
    description: nonEmptyString(body?.error_description) ?? nonEmptyString(body?.message) ?? nonEmptyString(nested?.message),
  };
}

function classifyOAuthReason(flow: KiroOAuthFlow, status: number | undefined, errorCode: string | undefined, description: string | undefined): Pick<KiroOAuthFailureDetails, "reason" | "permanent"> {
  const combined = [errorCode, description].filter((value): value is string => Boolean(value)).join(" ");
  if (/authorization[_-]?pending/i.test(combined)) return { reason: "http_error", permanent: false };
  if (/slow[_-]?down|rate[_-]?limit|thrott/i.test(combined) || status === 429) return { reason: "rate_limited", permanent: false };
  if (/access[_-]?denied|authorization[_-]?denied|user[_-]?denied/i.test(combined)) return { reason: "authorization_denied", permanent: true };
  if (/expired[_-]?token|device.*expired|expired.*device/i.test(combined)) return { reason: "device_code_expired", permanent: true };
  if (/invalid[_-]?client|unauthorized[_-]?client/i.test(combined)) return { reason: "client_rejected", permanent: true };
  if (/invalid[_-]?grant|refresh[_ -]?token.*(expired|revoked|invalid|reused|not found)|token.*(expired|revoked|invalid|rejected)/i.test(combined)) {
    return { reason: "token_rejected", permanent: true };
  }
  if (flow === "refresh" && (status === 400 || status === 401)) return { reason: "token_rejected", permanent: true };
  return { reason: status === undefined ? "request_failed" : "http_error", permanent: false };
}

function oauthFailureMessage(prefix: string, details: KiroOAuthFailureDetails): string {
  const status = details.status === undefined ? "" : ` HTTP ${details.status};`;
  const code = details.errorCode ? ` code=${redactSensitiveString(details.errorCode)};` : "";
  const action = details.permanent ? "reauthentication is required" : "failure is retryable";
  return `${prefix}:${status}${code} reason=${details.reason}; ${action}.`;
}

export function classifyKiroOAuthFailure(
  flow: KiroOAuthFlow,
  prefix: string,
  input: {
    providerId?: string;
    status?: number;
    body?: JsonRecord;
    cause?: unknown;
    reason?: KiroOAuthFailureDetails["reason"];
    permanent?: boolean;
  },
): KiroOAuthFailureError {
  const { code: errorCode, description } = oauthErrorParts(input.body);
  const classified = input.reason && input.permanent !== undefined ? { reason: input.reason, permanent: input.permanent } : classifyOAuthReason(flow, input.status, errorCode, description);
  const details: KiroOAuthFailureDetails = {
    providerId: input.providerId ?? "kiro",
    flow,
    status: input.status,
    errorCode: errorCode ? redactSensitiveString(errorCode) : undefined,
    reason: classified.reason,
    permanent: classified.permanent,
    retryable: !classified.permanent,
    source: "extension",
  };
  if (details.status === undefined) delete details.status;
  if (details.errorCode === undefined) delete details.errorCode;
  return new KiroOAuthFailureError(oauthFailureMessage(prefix, details), details, { cause: input.cause });
}

function configuredKiroOAuthFailure(
  config: KiroOAuthConfig,
  flow: KiroOAuthFlow,
  prefix: string,
  input: Parameters<typeof classifyKiroOAuthFailure>[2],
): KiroOAuthFailureError {
  return classifyKiroOAuthFailure(flow, prefix, { ...input, providerId: nonEmptyString(config.providerId) ?? "kiro" });
}

function expiresAt(expiresIn: unknown): number {
  return Date.now() + numericSeconds(expiresIn, DEFAULT_TOKEN_EXPIRES_IN_SECONDS) * 1000;
}

async function registerClient(config: KiroOAuthConfig): Promise<{ clientId: string; clientSecret: string }> {
  const payload: JsonRecord = {
    clientName: config.clientName,
    clientType: config.clientType,
    scopes: config.scopes,
    grantTypes: config.grantTypes,
  };
  if (config.issuerUrl && !config.skipIssuerUrlForRegistration) payload.issuerUrl = config.issuerUrl;

  const failure: OAuthFailureFactory = (input) => configuredKiroOAuthFailure(config, "login", "Kiro client registration failed", input);
  const body = await postJson(config, endpoint(config.region, "client/register"), OIDC_JSON_HEADERS, payload, failure);

  const clientId = nonEmptyString(body.clientId);
  const clientSecret = nonEmptyString(body.clientSecret);
  if (!clientId || !clientSecret) throw failure({ reason: "missing_required_fields", permanent: false });
  return { clientId, clientSecret };
}

async function requestDeviceCode(config: KiroOAuthConfig, client: { clientId: string; clientSecret: string }): Promise<JsonRecord> {
  const failure: OAuthFailureFactory = (input) => configuredKiroOAuthFailure(config, "login", "Kiro device authorization failed", input);
  return postJson(config, endpoint(config.region, "device_authorization"), OIDC_JSON_HEADERS, { clientId: client.clientId, clientSecret: client.clientSecret, startUrl: config.startUrl }, failure);
}

async function pollDeviceToken(config: KiroOAuthConfig, client: { clientId: string; clientSecret: string }, deviceCode: string): Promise<JsonRecord> {
  const failure: OAuthFailureFactory = (input) => configuredKiroOAuthFailure(config, "login", "Kiro token polling failed", input);
  return postJson(
    config,
    endpoint(config.region, "token"),
    OIDC_JSON_HEADERS,
    {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
    failure,
    (body, response) => response.ok || body.error === "authorization_pending" || body.error === "slow_down",
  );
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Kiro OAuth login aborted."));
      return;
    }
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Kiro OAuth login aborted."));
    };
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function localCallbackPath(config: KiroOAuthConfig): string {
  const configuredPath = configString(config, "socialCallbackPath", DEFAULT_SOCIAL_CALLBACK_PATH);
  return configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`;
}

function hasExplicitPortalConfig(config: KiroOAuthConfig): boolean {
  return Boolean(nonEmptyString((config as Partial<KiroOAuthConfig>).socialPortalUrl) && nonEmptyString((config as Partial<KiroOAuthConfig>).socialPortalRedirectUri));
}

function getPortalRedirectUrl(config: KiroOAuthConfig): URL | null {
  if (!hasExplicitPortalConfig(config)) return null;
  const raw = configString(config, "socialPortalRedirectUri", DEFAULT_SOCIAL_PORTAL_REDIRECT_URI);
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname.toLowerCase()) ? parsed : null;
  } catch {
    return null;
  }
}

function makeCallbackUrl(baseUri: string, callbackPath: string, authMethod: (typeof SOCIAL_AUTH_METHODS)[number]): string {
  const url = new URL(callbackPath, baseUri.endsWith("/") ? baseUri : `${baseUri}/`);
  url.searchParams.set("login_option", authMethod);
  return url.toString();
}

function responseWithHtml(response: ServerResponse, status: number, html: string, location?: string): void {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  };
  if (location) headers.Location = location;
  response.writeHead(status, headers);
  response.end(html);
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function startLocalCallbackServer(config: KiroOAuthConfig, authMethod: (typeof SOCIAL_AUTH_METHODS)[number]): Promise<LocalCallbackServerHandle | null> {
  const redirectUrl = getPortalRedirectUrl(config);
  if (!redirectUrl) return null;

  const callbackPath = localCallbackPath(config);
  const requestedPort = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 0;
  const firstPort = positiveInteger(requestedPort, 0);
  const lastPort = firstPort > 0 ? firstPort + DEFAULT_SOCIAL_CALLBACK_PORT_SPAN : 0;
  const listenHost = redirectUrl.hostname === "localhost" ? "localhost" : redirectUrl.hostname;
  let settled = false;
  let settleWait: ((value: string | null) => void) | null = null;
  let boundPort = firstPort;

  const callbackPromise = new Promise<string | null>((resolve) => {
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${redirectUrl.hostname || "localhost"}:${boundPort || 0}`);
    if (requestUrl.pathname !== callbackPath) {
      responseWithHtml(response, 404, LOCAL_CALLBACK_ERROR_HTML);
      return;
    }

    const fullUrl = `${redirectUrl.protocol}//${redirectUrl.hostname}:${boundPort}${request.url ?? ""}`;
    settleWait?.(fullUrl);
    responseWithHtml(response, 302, LOCAL_CALLBACK_SUCCESS_HTML, `${DEFAULT_SOCIAL_PORTAL_URL}?auth_status=success&redirect_from=kirocli`);
  });

  let lastError: Error | null = null;
  const ports = firstPort > 0 ? Array.from({ length: lastPort - firstPort + 1 }, (_, index) => firstPort + index) : [0];
  for (const port of ports) {
    try {
      await listen(server, listenHost, port);
      const address = server.address();
      boundPort = typeof address === "object" && address ? address.port : port;
      lastError = null;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((lastError as Error & { code?: string }).code !== "EADDRINUSE") break;
    }
  }

  if (lastError) {
    await closeServer(server).catch(() => undefined);
    return null;
  }

  const redirectBaseUri = `${redirectUrl.protocol}//${redirectUrl.hostname}:${boundPort}`;
  return {
    redirectBaseUri,
    callbackUrl: makeCallbackUrl(redirectBaseUri, callbackPath, authMethod),
    waitForCallback: async () => callbackPromise,
    cancelWait: () => settleWait?.(null),
    close: async () => closeServer(server),
  };
}

interface DeviceAuthorization {
  client: { clientId: string; clientSecret: string };
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

async function startDeviceAuthorization(config: KiroOAuthConfig): Promise<DeviceAuthorization> {
  const client = await registerClient(config);
  const device = await requestDeviceCode(config, client);
  const deviceCode = nonEmptyString(device.deviceCode);
  const userCode = nonEmptyString(device.userCode);
  const verificationUri = nonEmptyString(device.verificationUri);
  const verificationUriComplete = nonEmptyString(device.verificationUriComplete) ?? verificationUri;
  if (!deviceCode || !userCode || !verificationUri) throw configuredKiroOAuthFailure(config, "login", "Kiro device authorization failed", { reason: "missing_required_fields", permanent: false });
  return {
    client,
    deviceCode,
    userCode,
    verificationUrl: verificationUriComplete ?? verificationUri,
    expiresInSeconds: numericSeconds(device.expiresIn, 600),
    intervalSeconds: Math.max(1, numericSeconds(device.interval, 5)),
  };
}

async function loginWithBuilderId(config: KiroOAuthConfig, callbacks: OAuthLoginCallbacks, logger: DebugLogger): Promise<KiroCredentials> {
  const auth = await startDeviceAuthorization(config);
  callbacks.onAuth({
    url: auth.verificationUrl,
    instructions: `Open the Kiro authorization URL and enter code ${auth.userCode}.`,
  });
  return pollDeviceAuthorization(config, auth, callbacks, logger);
}

async function pollDeviceAuthorization(config: KiroOAuthConfig, auth: DeviceAuthorization, callbacks: OAuthLoginCallbacks, logger: DebugLogger): Promise<KiroCredentials> {
  const { client, deviceCode } = auth;
  const expiresIn = auth.expiresInSeconds;
  const intervalMs = auth.intervalSeconds * 1000;
  const deadline = Date.now() + expiresIn * 1000;
  let nextIntervalMs = intervalMs;

  while (Date.now() < deadline) {
    await wait(nextIntervalMs, callbacks.signal);
    const token = await pollDeviceToken(config, client, deviceCode);
    const access = nonEmptyString(token.accessToken);
    if (access) {
      const refresh = nonEmptyString(token.refreshToken);
      if (!refresh) throw configuredKiroOAuthFailure(config, "login", "Kiro token polling failed", { reason: "missing_required_fields", permanent: false });
      return {
        access,
        refresh,
        expires: expiresAt(token.expiresIn),
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        region: config.region,
        authMethod: "builder-id",
      };
    }

    const error = nonEmptyString(token.error);
    if (error === "slow_down") nextIntervalMs += intervalMs;
    callbacks.onProgress?.(error === "slow_down" ? "Kiro authorization is pending; slowing polling interval." : "Waiting for Kiro authorization to complete.");
  }

  logger.warn("oauth_device_code_expired", { provider: nonEmptyString(config.providerId) ?? "kiro" });
  throw configuredKiroOAuthFailure(config, "login", "Kiro OAuth device code expired before authorization completed", { body: { error: "expired_token" } });
}

async function selectAuthMethod(config: KiroOAuthConfig, callbacks: OAuthLoginCallbacks): Promise<KiroAuthMethod | typeof PORTAL_METHOD> {
  if (!callbacks.onSelect) return PORTAL_METHOD;
  const selected = await callbacks.onSelect({
    message: "Choose a Kiro sign-in method.",
    options: [
      { id: PORTAL_METHOD, label: "Kiro sign-in page (Google, GitHub, or your organization)" },
      ...AUTH_METHODS.map((method) => ({ id: method, label: config.methodLabels[method] })),
    ],
  });
  if (selected === PORTAL_METHOD) return PORTAL_METHOD;
  if (selected === undefined) {
    throw configuredKiroOAuthFailure(config, "login", "Kiro OAuth login was cancelled", { reason: "authorization_denied", permanent: true });
  }
  if (!isKiroAuthMethod(selected)) {
    throw configuredKiroOAuthFailure(config, "login", "Kiro OAuth login method is not supported", { reason: "unsupported_auth_method", permanent: true });
  }
  return selected;
}

function applyPkceParams(url: URL, codeChallenge: string, state: string): void {
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
}

function buildLegacySocialAuthorizeUrl(config: KiroOAuthConfig, authMethod: (typeof SOCIAL_AUTH_METHODS)[number], codeChallenge: string, state: string, redirectUri: string): string {
  const url = new URL(config.socialAuthorizeUrl);
  url.searchParams.set("idp", SOCIAL_IDP_BY_METHOD[authMethod]);
  url.searchParams.set("redirect_uri", redirectUri);
  applyPkceParams(url, codeChallenge, state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

function buildPortalAuthorizeUrl(config: KiroOAuthConfig, codeChallenge: string, state: string, redirectBaseUri: string): string {
  const url = new URL(configString(config, "socialPortalUrl", DEFAULT_SOCIAL_PORTAL_URL));
  applyPkceParams(url, codeChallenge, state);
  url.searchParams.set("redirect_uri", redirectBaseUri);
  url.searchParams.set("redirect_from", "kirocli");
  return url.toString();
}

async function requestManualCallback(callbacks: OAuthLoginCallbacks, config: KiroOAuthConfig, authMethod: KiroAuthMethod, placeholderRedirectUri: string): Promise<string> {
  if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
  return callbacks.onPrompt({
    message: `Paste the full Kiro ${config.methodLabels[authMethod]} callback URL.`,
    placeholder: `${placeholderRedirectUri}${placeholderRedirectUri.includes("?") ? "&" : "?"}code=...&state=...`,
  });
}

function assertCallbackUrlMatchesConfig(callbackUrl: URL, configuredRedirectUri: string, providerId: string): void {
  let expected: URL;
  try {
    expected = new URL(configuredRedirectUri);
  } catch {
    throw classifyKiroOAuthFailure("login", "Kiro social OAuth redirect URI is invalid", { providerId, reason: "invalid_callback", permanent: true });
  }

  if (
    callbackUrl.protocol !== expected.protocol ||
    callbackUrl.hostname.toLowerCase() !== expected.hostname.toLowerCase() ||
    callbackUrl.port !== expected.port ||
    callbackUrl.pathname !== expected.pathname ||
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.hash
  ) {
    throw classifyKiroOAuthFailure("login", "Kiro social OAuth callback URL is invalid", { providerId, reason: "invalid_callback", permanent: true });
  }
}

function parseSocialCallback(input: string, expectedState: string, configuredRedirectUri: string, authMethod: (typeof SOCIAL_AUTH_METHODS)[number], providerId: string): string {
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(input.trim());
  } catch {
    throw classifyKiroOAuthFailure("login", "Kiro social OAuth requires the full callback URL", { providerId, reason: "invalid_callback", permanent: true });
  }

  assertCallbackUrlMatchesConfig(callbackUrl, configuredRedirectUri, providerId);
  const loginOption = nonEmptyString(callbackUrl.searchParams.get("login_option"));
  if (loginOption && loginOption.toLowerCase() !== authMethod) {
    throw classifyKiroOAuthFailure("login", "Kiro social OAuth callback was for a different sign-in method", { providerId, reason: "invalid_callback", permanent: true });
  }
  const error = nonEmptyString(callbackUrl.searchParams.get("error"));
  if (error) throw classifyKiroOAuthFailure("login", "Kiro social OAuth authorization was denied", { providerId, body: { error } });
  const states = callbackUrl.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) {
    throw classifyKiroOAuthFailure("login", "Kiro social OAuth callback state did not match", { providerId, reason: "state_mismatch", permanent: true });
  }
  const codes = callbackUrl.searchParams.getAll("code");
  const code = codes.length === 1 ? nonEmptyString(codes[0]) : undefined;
  if (!code) throw classifyKiroOAuthFailure("login", "Kiro social OAuth callback did not include an authorization code", { providerId, reason: "invalid_callback", permanent: true });
  return code;
}

function buildProfileRequestOverride(profileArn: string | undefined): { request?: { headers: Record<string, string> } } {
  return profileArn ? { request: { headers: { [KIRO_PROFILE_ARN_HEADER]: profileArn } } } : {};
}

async function exchangeSocialCode(config: KiroOAuthConfig, authMethod: (typeof SOCIAL_AUTH_METHODS)[number], code: string, codeVerifier: string, redirectUri: string): Promise<KiroCredentials> {
  const failure: OAuthFailureFactory = (input) => configuredKiroOAuthFailure(config, "login", "Kiro social token exchange failed", input);
  const body = await postJson(config, config.socialTokenUrl, SOCIAL_JSON_HEADERS, { code, code_verifier: codeVerifier, redirect_uri: redirectUri }, failure);

  const access = responseString(body, "accessToken", "access_token");
  const refresh = responseString(body, "refreshToken", "refresh_token");
  if (!access || !refresh) throw failure({ reason: "missing_required_fields", permanent: false });
  const profileArn = responseString(body, "profileArn", "profile_arn");
  return {
    access,
    refresh,
    expires: tokenExpiresAt(body),
    profileArn,
    authMethod,
    provider: SOCIAL_IDP_BY_METHOD[authMethod],
    ...buildProfileRequestOverride(profileArn),
  };
}

async function resolveCallbackInput(callbacks: OAuthLoginCallbacks, config: KiroOAuthConfig, authMethod: (typeof SOCIAL_AUTH_METHODS)[number], callbackServer: LocalCallbackServerHandle | null, placeholderRedirectUri: string): Promise<string> {
  if (!callbackServer) return requestManualCallback(callbacks, config, authMethod, placeholderRedirectUri);

  const serverResultPromise = callbackServer.waitForCallback().then((value) => value ? { source: "server" as const, value } : null);
  const manualResultPromise = requestManualCallback(callbacks, config, authMethod, callbackServer.callbackUrl).then((value) => ({ source: "manual" as const, value }));
  const firstResult = await Promise.race([serverResultPromise, manualResultPromise]);
  if (firstResult) {
    if (firstResult.source === "manual") callbackServer.cancelWait();
    return firstResult.value;
  }
  return requestManualCallback(callbacks, config, authMethod, callbackServer.callbackUrl);
}

async function loginWithSocial(config: KiroOAuthConfig, authMethod: (typeof SOCIAL_AUTH_METHODS)[number], callbacks: OAuthLoginCallbacks, logger: DebugLogger): Promise<KiroCredentials> {
  const pkce = createPkce();
  let expectedState: string | undefined = pkce.state;
  let codeVerifier: string | undefined = pkce.codeVerifier;
  let callbackServer: LocalCallbackServerHandle | null = null;
  try {
    callbackServer = await startLocalCallbackServer(config, authMethod);
    const redirectBaseUri = callbackServer?.redirectBaseUri;
    const callbackRedirectUri = callbackServer?.callbackUrl ?? config.socialRedirectUri;
    callbacks.onAuth({
      url: redirectBaseUri
        ? buildPortalAuthorizeUrl(config, pkce.codeChallenge, pkce.state, redirectBaseUri)
        : buildLegacySocialAuthorizeUrl(config, authMethod, pkce.codeChallenge, pkce.state, callbackRedirectUri),
      instructions: redirectBaseUri
        ? `Complete Kiro ${config.methodLabels[authMethod]} sign-in in the browser. Pi will capture the localhost callback automatically; paste the final callback URL only if capture fails.`
        : `Complete Kiro ${config.methodLabels[authMethod]} sign-in, then paste the full callback URL from the browser or app prompt.`,
    });
    callbacks.onProgress?.("Waiting for Kiro authentication callback...");
    const callbackInput = await resolveCallbackInput(callbacks, config, authMethod, callbackServer, callbackRedirectUri);
    const state = expectedState;
    const verifier = codeVerifier;
    expectedState = undefined;
    codeVerifier = undefined;
    if (!state || !verifier) throw configuredKiroOAuthFailure(config, "login", "Kiro social OAuth verifier was already used", { reason: "invalid_callback", permanent: true });
    const code = parseSocialCallback(callbackInput, state, callbackRedirectUri, authMethod, nonEmptyString(config.providerId) ?? "kiro");
    callbacks.onProgress?.("Exchanging Kiro authorization code...");
    return exchangeSocialCode(config, authMethod, code, verifier, callbackRedirectUri);
  } finally {
    expectedState = undefined;
    codeVerifier = undefined;
    try {
      await callbackServer?.close();
    } catch (error) {
      logger.warn("oauth_callback_server_close_failed", { provider: nonEmptyString(config.providerId) ?? "kiro", error });
    }
  }
}


type PortalResult =
  | { kind: "social"; code: string; authMethod: (typeof SOCIAL_AUTH_METHODS)[number]; redirectUri: string }
  | { kind: "idc"; config: KiroOAuthConfig; auth: DeviceAuthorization };

// Mirrors pi-provider-kiro: open Kiro's own sign-in page, which offers Google, GitHub and
// "Sign in with your organization". Social sign-ins come back with a PKCE code; organization
// sign-ins come back with the org's start URL (issuer_url) and region (idc_region), which we
// turn into a standard IAM Identity Center device-code login.
async function loginWithPortal(config: KiroOAuthConfig, callbacks: OAuthLoginCallbacks, logger: DebugLogger): Promise<KiroCredentials> {
  const providerId = nonEmptyString(config.providerId) ?? "kiro";
  const pkce = createPkce();
  const portalUrl = new URL(DEFAULT_SOCIAL_PORTAL_URL);
  applyPkceParams(portalUrl, pkce.codeChallenge, pkce.state);
  portalUrl.searchParams.set("redirect_uri", PORTAL_REDIRECT_URI);
  portalUrl.searchParams.set("redirect_from", "kirocli");

  let server: Server | undefined;
  const result = await new Promise<PortalResult>((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    callbacks.signal?.addEventListener("abort", () => fail(callbacks.signal?.reason ?? new Error("Kiro OAuth login aborted.")), { once: true });

    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", PORTAL_REDIRECT_URI);
        if (!PORTAL_CALLBACK_PATHS.includes(url.pathname)) {
          responseWithHtml(response, 404, LOCAL_CALLBACK_ERROR_HTML);
          return;
        }
        if (url.searchParams.get("state") !== pkce.state) {
          responseWithHtml(response, 400, LOCAL_CALLBACK_ERROR_HTML);
          fail(classifyKiroOAuthFailure("login", "Kiro sign-in callback state did not match", { providerId, reason: "state_mismatch", permanent: true }));
          return;
        }
        const error = nonEmptyString(url.searchParams.get("error"));
        if (error) {
          responseWithHtml(response, 400, LOCAL_CALLBACK_ERROR_HTML);
          fail(classifyKiroOAuthFailure("login", "Kiro sign-in was denied", { providerId, body: { error } }));
          return;
        }

        const issuerUrl = nonEmptyString(url.searchParams.get("issuer_url"));
        if (issuerUrl) {
          const idcRegion = nonEmptyString(url.searchParams.get("idc_region")) ?? "us-east-1";
          if (!/^https:\/\//i.test(issuerUrl) || !AWS_REGION_PATTERN.test(idcRegion)) {
            responseWithHtml(response, 400, LOCAL_CALLBACK_ERROR_HTML);
            fail(classifyKiroOAuthFailure("login", "Kiro organization sign-in returned an invalid start URL or region", { providerId, reason: "invalid_callback", permanent: true }));
            return;
          }
          const orgConfig: KiroOAuthConfig = { ...config, region: idcRegion, startUrl: issuerUrl, skipIssuerUrlForRegistration: true };
          const auth = await startDeviceAuthorization(orgConfig);
          responseWithHtml(response, 302, LOCAL_CALLBACK_SUCCESS_HTML, auth.verificationUrl);
          resolve({ kind: "idc", config: orgConfig, auth });
          return;
        }

        const code = nonEmptyString(url.searchParams.get("code"));
        const loginOption = nonEmptyString(url.searchParams.get("login_option"))?.toLowerCase();
        const authMethod = SOCIAL_AUTH_METHODS.find((method) => method === loginOption);
        if (!code || !authMethod) {
          responseWithHtml(response, 400, LOCAL_CALLBACK_ERROR_HTML);
          fail(classifyKiroOAuthFailure("login", "Kiro sign-in callback was missing a code or sign-in method", { providerId, reason: "invalid_callback", permanent: true }));
          return;
        }
        const redirectUri = `${PORTAL_REDIRECT_URI}${url.pathname === "/" ? "" : url.pathname}?login_option=${loginOption}`;
        responseWithHtml(response, 200, LOCAL_CALLBACK_SUCCESS_HTML);
        resolve({ kind: "social", code, authMethod, redirectUri });
      } catch (error) {
        responseWithHtml(response, 500, LOCAL_CALLBACK_ERROR_HTML);
        fail(error);
      }
    });

    // Bind to loopback only so the callback is not reachable from the network.
    server.once("error", fail);
    server.listen(PORTAL_PORT, "127.0.0.1", () => {
      callbacks.onAuth({
        url: portalUrl.toString(),
        instructions: "Sign in on the Kiro page in your browser (Google, GitHub, or your organization).",
      });
      callbacks.onProgress?.("Waiting for Kiro sign-in...");
    });
  }).finally(async () => {
    if (server) await closeServer(server).catch((error) => logger.warn("oauth_callback_server_close_failed", { provider: providerId, error }));
  });

  if (result.kind === "social") {
    callbacks.onProgress?.("Exchanging Kiro authorization code...");
    return exchangeSocialCode(config, result.authMethod, result.code, pkce.codeVerifier, result.redirectUri);
  }
  callbacks.onProgress?.(`Approve the request in your browser. If asked, your code is ${result.auth.userCode}.`);
  return pollDeviceAuthorization(result.config, result.auth, callbacks, logger);
}

async function loginKiro(config: KiroOAuthConfig, callbacks: OAuthLoginCallbacks, logger: DebugLogger): Promise<KiroCredentials> {
  const authMethod = await selectAuthMethod(config, callbacks);
  if (authMethod === PORTAL_METHOD) return loginWithPortal(config, callbacks, logger);
  if (authMethod === "builder-id") return loginWithBuilderId(config, callbacks, logger);
  return loginWithSocial(config, authMethod, callbacks, logger);
}

async function refreshWithOidc(credentials: KiroCredentials, providerId: string, config?: Pick<KiroOAuthConfig, "requestTimeoutMs">): Promise<KiroCredentials> {
  const region = credentials.region ?? "us-east-1";
  const clientId = nonEmptyString(credentials.clientId);
  const clientSecret = nonEmptyString(credentials.clientSecret);
  if (!clientId || !clientSecret) throw classifyKiroOAuthFailure("refresh", "Kiro OIDC refresh requires client metadata", { providerId, reason: "missing_client_metadata", permanent: true });

  const failure: OAuthFailureFactory = (input) => classifyKiroOAuthFailure("refresh", "Kiro token refresh failed", { ...input, providerId });
  const body = await postJson(config, endpoint(region, "token"), OIDC_JSON_HEADERS, { clientId, clientSecret, refreshToken: credentials.refresh, grantType: "refresh_token" }, failure);

  const access = nonEmptyString(body.accessToken);
  if (!access) throw failure({ reason: "missing_required_fields", permanent: false });
  return {
    ...credentials,
    access,
    refresh: nonEmptyString(body.refreshToken) ?? credentials.refresh,
    expires: expiresAt(body.expiresIn),
    authMethod: "builder-id",
  };
}

async function refreshWithSocialEndpoint(config: KiroOAuthConfig, credentials: KiroCredentials, authMethod: (typeof SOCIAL_AUTH_METHODS)[number]): Promise<KiroCredentials> {
  const failure: OAuthFailureFactory = (input) => configuredKiroOAuthFailure(config, "refresh", "Kiro social token refresh failed", input);
  const body = await postJson(config, config.socialRefreshUrl, SOCIAL_JSON_HEADERS, { refreshToken: credentials.refresh }, failure);

  const access = responseString(body, "accessToken", "access_token");
  if (!access) throw failure({ reason: "missing_required_fields", permanent: false });
  const profileArn = responseString(body, "profileArn", "profile_arn") ?? credentials.profileArn;
  return {
    ...credentials,
    access,
    refresh: responseString(body, "refreshToken", "refresh_token") ?? credentials.refresh,
    expires: tokenExpiresAt(body),
    profileArn,
    authMethod,
    provider: SOCIAL_IDP_BY_METHOD[authMethod],
    ...buildProfileRequestOverride(profileArn),
  };
}

export interface KiroOAuthProviderOptions {
  providerId?: string;
  displayName?: string;
  modelDiscovery?: ModelDiscoveryConfig;
  profileArn?: string;
}

export function createKiroOAuthProvider(config: KiroOAuthConfig, logger: DebugLogger, options: KiroOAuthProviderOptions = {}): OAuthProviderInterface {
  const { providerId, displayName } = resolveOAuthProviderIdentity(options, config);
  const providerConfig: KiroOAuthConfig = { ...config, providerId };
  const discovery: ModelDiscoveryConfig = options.modelDiscovery ?? { enabled: false };
  return {
    id: providerId,
    name: displayName,
    async login(callbacks) {
      const credentials = await loginKiro(providerConfig, callbacks, logger);
      callbacks.onProgress?.("Fetching your available Kiro models...");
      return withDiscoveredCatalog(credentials, undefined, options.profileArn, discovery, logger, providerId);
    },
    async refreshToken(credentials) {
      const kiroCredentials = credentials as KiroCredentials;
      if (!kiroCredentials.refresh) throw classifyKiroOAuthFailure("refresh", "Kiro OAuth refresh requires a refresh token", { providerId, reason: "missing_refresh_token", permanent: true });
      const authMethod = normalizeStoredAuthMethod(kiroCredentials.authMethod);
      if (!authMethod) throw classifyKiroOAuthFailure("refresh", "Kiro OAuth credential auth method is not supported", { providerId, reason: "unsupported_auth_method", permanent: true });
      const refreshed = authMethod === "builder-id"
        ? await refreshWithOidc(kiroCredentials, providerId, providerConfig)
        : await refreshWithSocialEndpoint(providerConfig, kiroCredentials, authMethod);
      return withDiscoveredCatalog(refreshed, kiroCredentials, options.profileArn, discovery, logger, providerId);
    },
    getApiKey(credentials) {
      return credentials.access;
    },
    modifyModels: (models, credentials) => {
      const withCatalog = applyDiscoveredModels(models, credentials, providerId);
      // Stamp the profile ARN only onto this provider's models, not every provider's.
      const ours = applyProfileArnToModels(withCatalog.filter((model) => model.provider === providerId), credentials);
      let index = 0;
      return withCatalog.map((model) => (model.provider === providerId ? ours[index++] : model));
    },
  };
}
