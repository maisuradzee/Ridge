package player

import (
	"errors"
	"testing"
	"time"
)

func TestAuthorizeHostilePlayerActionRequiresLiveAuthoritativeLease(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	valid := PresenceEvidence{PlayerID: "player-1", SessionID: "session-1", Status: "active", LeaseExpiresAt: now.Add(time.Minute)}
	if err := AuthorizeHostilePlayerAction(valid, now); err != nil {
		t.Fatalf("valid live lease rejected: %v", err)
	}
}

func TestAuthorizeHostilePlayerActionProtectsOfflineAndExpiredPlayers(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		presence PresenceEvidence
	}{
		{"closed session", PresenceEvidence{PlayerID:"p", SessionID:"s", Status:"closed", LeaseExpiresAt:now.Add(time.Hour)}},
		{"expired active lease", PresenceEvidence{PlayerID:"p", SessionID:"s", Status:"active", LeaseExpiresAt:now}},
		{"expired in past", PresenceEvidence{PlayerID:"p", SessionID:"s", Status:"active", LeaseExpiresAt:now.Add(-time.Second)}},
		{"offline status", PresenceEvidence{PlayerID:"p", SessionID:"s", Status:"offline", LeaseExpiresAt:now.Add(time.Hour)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := AuthorizeHostilePlayerAction(tc.presence, now); !errors.Is(err, ErrHostileActionDenied) {
				t.Fatalf("expected hostile action denial, got %v", err)
			}
		})
	}
}

func TestAuthorizeHostilePlayerActionFailsClosedOnMissingPresence(t *testing.T) {
	now := time.Now().UTC()
	cases := []PresenceEvidence{
		{},
		{PlayerID:"p", Status:"active", LeaseExpiresAt:now.Add(time.Minute)},
		{SessionID:"s", Status:"active", LeaseExpiresAt:now.Add(time.Minute)},
		{PlayerID:"p", SessionID:"s", Status:"active"},
	}
	for i, presence := range cases {
		if err := AuthorizeHostilePlayerAction(presence, now); !errors.Is(err, ErrPresenceUnverified) {
			t.Fatalf("case %d: expected fail-closed presence error, got %v", i, err)
		}
	}
}

func TestAuthorizeHostilePlayerActionRejectsZeroClock(t *testing.T) {
	presence := PresenceEvidence{PlayerID:"p", SessionID:"s", Status:"active", LeaseExpiresAt:time.Now().Add(time.Hour)}
	if err := AuthorizeHostilePlayerAction(presence, time.Time{}); !errors.Is(err, ErrPresenceUnverified) {
		t.Fatalf("expected missing authoritative time to fail closed, got %v", err)
	}
}
