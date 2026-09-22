package validate

import (
	"fmt"
	"net/http"

	"github.com/sysadminsmedia/homebox/backend/internal/sys/config"
)

// maxNotifierRedirects caps redirect hops for outbound delivery, matching net/http's
// default so behavior is unchanged for legitimate redirect chains.
const maxNotifierRedirects = 10

// NotifierGuardedHTTPClient returns an *http.Client whose redirects are
// re-validated against the notifier SSRF policy on every hop.
//
// shoutrrr's generic service builds its own bare &http.Client{} per request
// rather than using http.DefaultClient, so a host that passes the initial
// ValidateNotifierURL gate could otherwise respond with a 30x redirect to
// localhost / link-local / cloud-metadata / any other blocked destination,
// and the follow-up hop would be delivered without re-checking the policy —
// bypassing the SSRF guards. Callers must pass this client explicitly to
// shoutrrr (e.g. via shoutrrr.NewSenderWithOptions with
// types.SenderOptions{HTTPClient: ...}); it is not picked up implicitly.
func NotifierGuardedHTTPClient(cfg *config.NotifierConf) *http.Client {
	return &http.Client{CheckRedirect: NotifierRedirectGuard(cfg)}
}

// NotifierRedirectGuard returns an http.Client CheckRedirect hook that refuses any
// redirect whose target resolves to an address blocked by cfg, and caps the number
// of hops. Returning a non-nil error aborts the request with that error rather than
// following the redirect, so a blocked hop surfaces as a delivery failure.
func NotifierRedirectGuard(cfg *config.NotifierConf) func(req *http.Request, via []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxNotifierRedirects {
			return fmt.Errorf("stopped after %d redirects", maxNotifierRedirects)
		}

		// Defensive: with no policy configured, preserve default behavior (only the
		// hop cap above applies) rather than blocking every redirect.
		if cfg == nil {
			return nil
		}

		if err := validateHostAgainstPolicy(req.URL.Hostname(), cfg); err != nil {
			return fmt.Errorf("redirect to %s blocked by notifier SSRF policy: %w", req.URL.Redacted(), err)
		}
		return nil
	}
}
