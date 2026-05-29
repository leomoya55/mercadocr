/**
 * middleware/rateLimiters.js — shared, purpose-built rate limiters.
 *
 * The global apiLimiter (server.js) is a coarse 100/15min/IP backstop. These are
 * tighter limits on the specific endpoints malicious users actually abuse:
 * listing creation (spam listings / fake WhatsApp ads) and reporting (report
 * flooding). Keyed by Firebase UID when authenticated so one user can't rotate
 * IPs to evade the limit; falls back to IP for unauthenticated callers.
 *
 * NOTE ON SERVERLESS (Vercel): express-rate-limit's default store is in-memory
 * and per-instance. Under multiple concurrent Vercel function instances these
 * limits are approximate, not global. They still meaningfully blunt single-source
 * abuse. For hard global limits, move to a shared store (e.g. Upstash Redis via
 * rate-limit-redis) — flagged in the launch audit as a post-launch hardening.
 */

const rateLimit = require('express-rate-limit');

const keyByUidOrIp = (req /*, res */) => req.uid || req.ip;

// Listing creation: 10 new listings per 10 minutes per user.
const createListingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUidOrIp,
  message: { error: 'Estás publicando demasiado rápido. Espera unos minutos.', code: 'RATE_LIMITED' },
});

// Reports: 20 per hour per user.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUidOrIp,
  message: { error: 'Demasiados reportes. Intenta más tarde.', code: 'RATE_LIMITED' },
});

// Generic strict limiter for other sensitive writes (profile updates, checkout).
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUidOrIp,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.', code: 'RATE_LIMITED' },
});

module.exports = { createListingLimiter, reportLimiter, writeLimiter };
