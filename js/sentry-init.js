/**
 * sentry-init.js — optional, self-contained frontend error monitoring.
 *
 * Activates ONLY when a DSN is provided via a meta tag in the page <head>:
 *   <meta name="sentry-dsn" content="https://examplePublicKey@o0.ingest.sentry.io/0">
 *
 * If the meta tag is absent/empty, this is a complete no-op (zero behavior change
 * — safe to ship before the DSN exists). If the Sentry CDN is blocked or fails to
 * load, it fails silently and never affects the page. No PII is sent; query
 * strings (which may carry tokens) are stripped before send.
 *
 * Load this in <head> BEFORE your other scripts so early errors are captured.
 */
(function () {
  'use strict';
  try {
    var meta = document.querySelector('meta[name="sentry-dsn"]');
    var dsn  = meta && meta.getAttribute('content');
    if (!dsn) return; // disabled until a DSN is configured

    var s = document.createElement('script');
    // Pinned, widely-available Sentry browser bundle. Update the version if you
    // adopt a newer SDK, or replace this whole file with Sentry's Loader Script.
    s.src = 'https://browser.sentry-cdn.com/7.120.0/bundle.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function () {
      try {
        if (!window.Sentry) return;
        var host = location.hostname;
        window.Sentry.init({
          dsn: dsn,
          environment: (host === 'localhost' || host === '127.0.0.1') ? 'development' : 'production',
          sampleRate: 1.0,
          tracesSampleRate: 0,
          sendDefaultPii: false,
          beforeSend: function (event) {
            try {
              if (event.request && typeof event.request.url === 'string') {
                event.request.url = event.request.url.split('?')[0];
              }
            } catch (e) {}
            return event;
          },
        });
      } catch (e) { /* never break the page over telemetry */ }
    };
    s.onerror = function () { /* CDN blocked — silently ignore */ };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* absolute safety net */ }
})();
