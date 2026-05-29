/**
 * config/sentry.js — optional, production-safe error monitoring.
 *
 * DESIGN PRINCIPLES (must hold for a pre-launch additive change):
 *   • Zero behavior change when SENTRY_DSN is not set — it's a pure no-op.
 *   • Never throws. A telemetry failure must NEVER break a request or boot.
 *   • No PII / secrets leave the server (cookies, headers, bodies are stripped).
 *   • Environment-aware (tags events with NODE_ENV).
 *
 * IMPORTANT: this module is required as the VERY FIRST line of server.js so the
 * Sentry SDK can install its instrumentation before express/mongoose load. We
 * load dotenv here too, because at that point server.js hasn't called it yet —
 * on Vercel the env vars are already present; locally this picks up .env.
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

let Sentry = null;
let enabled = false;

try {
  if (process.env.SENTRY_DSN) {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      tracesSampleRate: 0,      // errors only for beta — no performance overhead
      sendDefaultPii: false,    // do not attach IP / user identifiers
      beforeSend(event) {
        // Defense-in-depth: strip anything that could carry secrets/PII.
        if (event.request) {
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.data;
          if (typeof event.request.url === 'string') {
            event.request.url = event.request.url.split('?')[0]; // drop query string
          }
        }
        return event;
      },
    });
    enabled = true;
    console.log('[sentry] enabled (', process.env.NODE_ENV || 'development', ')');
  }
} catch (e) {
  // Missing package or bad DSN → stay disabled, never crash.
  console.warn('[sentry] not initialized:', e.message);
  Sentry = null;
  enabled = false;
}

/** Capture an error with optional structured context. Safe no-op when disabled. */
function captureException(err, extra) {
  if (!enabled || !Sentry) return;
  try {
    Sentry.captureException(err, extra ? { extra } : undefined);
  } catch (_) { /* swallow — telemetry must never break the caller */ }
}

/** Attach Sentry's express error handler (call AFTER all routes are mounted). */
function setupExpressErrorHandler(app) {
  if (!enabled || !Sentry) return;
  try {
    if (typeof Sentry.setupExpressErrorHandler === 'function') {
      Sentry.setupExpressErrorHandler(app);
    }
  } catch (e) {
    console.warn('[sentry] express handler not attached:', e.message);
  }
}

module.exports = { captureException, setupExpressErrorHandler, isEnabled: () => enabled };
