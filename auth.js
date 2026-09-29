/**
 * Shared-passcode gate.
 *
 * The app calls a metered API on every request, so a public URL is a public
 * bill. One passcode, handed to the class, keeps that closed without the
 * overhead of per-student accounts.
 *
 * Set APP_PASSCODE to turn it on. With the variable unset the gate is inert,
 * which is what you want for `npm start` on your own machine.
 */

import crypto from 'crypto';

const PASSCODE = process.env.APP_PASSCODE || '';
const COOKIE_NAME = 'critbot_session';
const SESSION_DAYS = 30;

export const authEnabled = Boolean(PASSCODE);

/**
 * The signing key is derived from the passcode rather than stored separately.
 * That means changing APP_PASSCODE invalidates every outstanding session for
 * free, which is the behaviour you want when a passcode leaks — and it removes
 * a second secret that would otherwise have to be kept in sync across deploys.
 */
const KEY = crypto.createHash('sha256')
  .update('critbot.session.v1:' + PASSCODE)
  .digest();

/** Paths that must stay reachable to a signed-out visitor. */
const OPEN_PATHS = new Set(['/healthz', '/login', '/logout', '/manifest.webmanifest']);
const OPEN_PREFIXES = ['/icons/'];

function isOpen(pathname) {
  return OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare digests instead:
  // fixed width, and the lengths themselves stop leaking.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function sign(expiry) {
  return crypto.createHmac('sha256', KEY).update(String(expiry)).digest('base64url');
}

function issueToken() {
  const expiry = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return expiry + '.' + sign(expiry);
}

function tokenValid(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expiry = Number(token.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  return safeEqual(token.slice(dot + 1), sign(expiry));
}

/** Minimal cookie lookup; avoids pulling in cookie-parser for one value. */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Throttles guessing. A passcode short enough to read aloud to a room is short
 * enough to brute-force over HTTP, so failures per IP buy an increasing delay.
 * In-memory is sufficient: a restart clearing the table costs an attacker more
 * than it costs us, and the app runs as a single instance.
 */
const attempts = new Map();
const LOCKOUT_AFTER = 5;

function lockoutRemaining(ip) {
  const record = attempts.get(ip);
  if (!record || record.count < LOCKOUT_AFTER) return 0;
  // 5th failure costs 30s, doubling to a 15-minute ceiling.
  const penalty = Math.min(30_000 * 2 ** (record.count - LOCKOUT_AFTER), 900_000);
  return Math.max(0, record.at + penalty - Date.now());
}

function recordFailure(ip) {
  const record = attempts.get(ip) || { count: 0, at: 0 };
  record.count += 1;
  record.at = Date.now();
  attempts.set(ip, record);
  // Unbounded growth would be a slow memory leak under a sustained attack.
  if (attempts.size > 5000) attempts.clear();
}

function loginPage({ error, next }) {
  const hint = error
    ? `<p class="error">${error}</p>`
    : '<p class="hint">Ask your instructor for the class passcode.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#121214">
<meta name="color-scheme" content="dark">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>Design Crit-Bot</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100svh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    background: #121214; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  form { width: 100%; max-width: 320px; text-align: center; }
  img { width: 72px; height: 72px; border-radius: 18px; margin-bottom: 20px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .hint, .error { font-size: 14px; line-height: 1.5; margin: 0 0 24px; }
  .hint { color: #a0a0aa; }
  .error { color: #ff4757; }
  input {
    width: 100%; padding: 14px 16px; font-size: 17px; /* 17px: iOS zooms below 16 */
    color: #f5f5f7; background: #1a1a1e;
    border: 1px solid #2e2e36; border-radius: 12px; text-align: center;
    letter-spacing: 0.08em;
  }
  input:focus { outline: none; border-color: #ff4757; }
  button {
    width: 100%; margin-top: 12px; padding: 14px; font-size: 16px; font-weight: 600;
    color: #fff; background: #ff4757; border: 0; border-radius: 12px; cursor: pointer;
  }
  button:active { opacity: 0.85; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <img src="/icons/icon-192.png" alt="">
    <h1>Design Crit-Bot</h1>
    ${hint}
    <input type="password" name="passcode" inputmode="text" autocomplete="current-password"
           placeholder="Passcode" autofocus required aria-label="Class passcode">
    <input type="hidden" name="next" value="${next}">
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}

/**
 * Escapes a redirect target and refuses anything that leaves this origin, so
 * the `next` parameter can't be used to bounce a student off-site.
 */
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value.replace(/[^a-zA-Z0-9/_\-.?=&]/g, '');
}

/**
 * Mounts the login routes and the gate. Call before any route that should be
 * protected, including the static handler.
 */
export function installAuth(app, express) {
  if (!authEnabled) {
    console.warn('⚠️ APP_PASSCODE is not set — every route is open to anyone with the URL.');
    return;
  }

  // Fly terminates TLS at its proxy, so req.secure and req.ip both depend on
  // trusting the forwarding headers it sets.
  app.set('trust proxy', 1);

  const form = express.urlencoded({ extended: false });

  app.get('/login', (req, res) => {
    if (tokenValid(readCookie(req.headers.cookie, COOKIE_NAME))) {
      return res.redirect(safeNext(req.query.next));
    }
    res.type('html').send(loginPage({ error: null, next: safeNext(req.query.next) }));
  });

  app.post('/login', form, (req, res) => {
    const wait = lockoutRemaining(req.ip);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      return res.status(429).type('html').send(loginPage({
        error: `Too many attempts. Try again in ${seconds}s.`,
        next: safeNext(req.body?.next)
      }));
    }

    if (!safeEqual(req.body?.passcode ?? '', PASSCODE)) {
      recordFailure(req.ip);
      return res.status(401).type('html').send(loginPage({
        error: 'That passcode did not match.',
        next: safeNext(req.body?.next)
      }));
    }

    attempts.delete(req.ip);
    res.cookie(COOKIE_NAME, issueToken(), {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
      path: '/'
    });
    res.redirect(safeNext(req.body?.next));
  });

  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (isOpen(req.path)) return next();
    if (tokenValid(readCookie(req.headers.cookie, COOKIE_NAME))) return next();

    // The front end reads this code to bounce to the login page mid-session;
    // a redirect here would hand fetch() an HTML page it can't parse.
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Session expired. Reload to sign in again.' });
    }
    res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  });

  console.log(`🔒 Passcode gate active (sessions last ${SESSION_DAYS} days).`);
}
