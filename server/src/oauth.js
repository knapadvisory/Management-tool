// Google / Microsoft single sign-on via OpenID Connect (authorization-code flow).
//
// SSO is a login method for people who ALREADY have a TeamHub account — we match
// on the verified email from the provider and never auto-create users (we don't
// know which workspace/role a stranger should get). Each provider is enabled only
// when its client id + secret are configured, so the feature is off by default.
//
// Config (env): GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET,
//               MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET.
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './auth.js';

const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  microsoft: {
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile',
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
  },
};

export function getProvider(name) {
  return PROVIDERS[name] || null;
}

export function providerConfigured(name) {
  const p = PROVIDERS[name];
  return !!(p && p.clientId() && p.clientSecret());
}

// Which providers the client should show buttons for.
export function enabledProviders() {
  return Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, providerConfigured(k)]));
}

// A signed, short-lived `state` value guards the callback against CSRF — it's
// self-contained (no server-side session needed) and expires in 10 minutes.
export function signState(provider) {
  return jwt.sign({ p: provider, n: Math.random().toString(36).slice(2) }, JWT_SECRET, { expiresIn: '10m' });
}
export function verifyState(state, provider) {
  try {
    return jwt.verify(state, JWT_SECRET).p === provider;
  } catch {
    return false;
  }
}

export function authUrl(name, redirectUri, state) {
  const p = PROVIDERS[name];
  const q = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
    prompt: 'select_account',
  });
  return `${p.authUrl}?${q.toString()}`;
}

// Exchange the authorization code for tokens and pull the verified email out of
// the id_token. We received the id_token directly from the provider's token
// endpoint over TLS using our client secret, so decoding its payload (rather than
// re-verifying the JWKS signature) is safe in this flow.
export async function exchangeCodeForIdentity(name, code, redirectUri) {
  const p = PROVIDERS[name];
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error('Could not complete sign-in with the provider.');
  const tok = await res.json();
  if (!tok.id_token) throw new Error('The provider did not return an identity token.');

  const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
  const email = (payload.email || payload.preferred_username || '').toLowerCase();
  // Google returns email_verified; Microsoft work/school accounts are verified by
  // virtue of the tenant sign-in, so treat a present address there as verified.
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true' || name === 'microsoft';
  return { email, emailVerified, name: payload.name || payload.given_name || '' };
}
