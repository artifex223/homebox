package validate_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/nicholas-fedor/shoutrrr"
	shoutrrrtypes "github.com/nicholas-fedor/shoutrrr/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/sysadminsmedia/homebox/backend/internal/sys/config"
	"github.com/sysadminsmedia/homebox/backend/internal/sys/validate"
)

// startVictimAndRedirector spins up two loopback servers: a "victim" that records
// whether it was reached, and a "redirector" that 307-redirects any request to the
// victim. It returns the generic+ notifier URL pointing at the redirector and a
// function reporting how many times the victim was hit.
func startVictimAndRedirector(t *testing.T) (notifierURL string, victimHits func() int32) {
	t.Helper()

	var hits int32
	victim := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(victim.Close)

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", victim.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	// shoutrrr's generic service wraps a plain http(s) URL as generic+http(s)://...
	return "generic+" + redirector.URL, func() int32 { return atomic.LoadInt32(&hits) }
}

// send delivers via a shoutrrr sender using the given HTTP client, mirroring how
// production code (BackgroundService.SendNotifiersToday) drives shoutrrr. Passing
// a nil client reproduces the library default: a bare &http.Client{} per request.
func send(t *testing.T, notifierURL string, client shoutrrrtypes.HTTPClient) error {
	t.Helper()

	sender, err := shoutrrr.NewSenderWithOptions(nil, shoutrrrtypes.SenderOptions{HTTPClient: client}, notifierURL)
	require.NoError(t, err)

	errs := sender.Send("Test message from Homebox", nil)
	return errs[0]
}

// TestNotifierRedirectSSRF_Unguarded documents the vulnerability: shoutrrr's generic
// service delivers via a bare &http.Client{} that follows redirects with no policy
// re-check. A host that passes the initial SSRF gate can 307-redirect to a blocked
// destination (here loopback) and the follow-up hop is delivered.
func TestNotifierRedirectSSRF_Unguarded(t *testing.T) {
	notifierURL, victimHits := startVictimAndRedirector(t)

	err := send(t, notifierURL, nil)
	require.NoError(t, err)
	assert.Equal(t, int32(1), victimHits(), "unguarded: redirect to loopback victim IS followed (SSRF)")
}

// TestNotifierRedirectSSRF_Guarded verifies the fix: sending through a client built
// with NotifierGuardedHTTPClient, a 307 to a blocked (loopback) destination is
// refused, the send fails, and the victim is never reached.
func TestNotifierRedirectSSRF_Guarded(t *testing.T) {
	notifierURL, victimHits := startVictimAndRedirector(t)

	guarded := validate.NotifierGuardedHTTPClient(&config.NotifierConf{BlockLocalhost: true})
	err := send(t, notifierURL, guarded)
	require.Error(t, err, "guarded: redirect to loopback must be refused and the send must fail")
	assert.Equal(t, int32(0), victimHits(), "guarded: the blocked redirect target must never be reached")
}
