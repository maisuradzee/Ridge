package player

import (
	"errors"
	"strings"
	"time"
)

var (
	ErrHostileActionDenied = errors.New("hostile player action denied by offline protection")
	ErrPresenceUnverified = errors.New("player presence is missing or cannot be verified")
)

// PresenceEvidence must be populated from the authoritative persistence layer,
// never from a client-supplied online/offline flag.
type PresenceEvidence struct {
	PlayerID       string
	SessionID      string
	Status         string
	LeaseExpiresAt time.Time
}

// AuthorizeHostilePlayerAction applies RIDGE's offline-safety invariant.
// Unknown, missing, closed, expired, or malformed presence fails closed.
// A successful result only establishes that the target has a live server-side
// session; combat/gameplay rules must still authorize the specific action.
func AuthorizeHostilePlayerAction(presence PresenceEvidence, now time.Time) error {
	if strings.TrimSpace(presence.PlayerID) == "" || strings.TrimSpace(presence.SessionID) == "" ||
		presence.LeaseExpiresAt.IsZero() || now.IsZero() {
		return ErrPresenceUnverified
	}
	if presence.Status != "active" || !presence.LeaseExpiresAt.After(now) {
		return ErrHostileActionDenied
	}
	return nil
}
