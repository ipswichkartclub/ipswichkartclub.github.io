/**
 * Deployment configuration.
 *
 * After you deploy the Worker, wrangler prints a URL like
 *   https://ikc-checkin-api.<your-subdomain>.workers.dev
 * Paste it into PRODUCTION_API below (no trailing slash) and commit.
 */
(function () {
  var PRODUCTION_API = 'https://ikc-checkin-api.drivers-briefing.workers.dev';

  var local = location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '[::1]';

  window.IKC_CONFIG = {
    // The local dev server (worker/dev-server.mjs) serves the API on the same
    // origin, so an empty base means "/api/..." resolves against localhost.
    apiBase: local ? '' : PRODUCTION_API,

    // Shown in the check-in page header.
    clubName: 'Ipswich Kart Club',

    // Wording of the acknowledgement a driver must tick before checking in.
    // The exact text is stored against each check-in, so if you reword it the
    // older records still show what was actually agreed to.
    ackText: 'I confirm that I have read and understood the driver briefing notes '
      + 'for this meeting, and agree to comply with them.',
  };
})();
