// Package uuid generates the random identifiers the agent needs (boot ids and
// request ids). The standard library has no UUID type and the protocol only
// requires an opaque, collision-free string, so this stays dependency-free.
package uuid

import (
	"crypto/rand"
	"encoding/hex"
)

// NewV4 returns a random RFC 4122 version 4 UUID.
//
// It reads from crypto/rand and propagates a failure rather than falling back
// to a weaker source: a boot id collision would make two boots share a metering
// sequence space, and the control plane would then treat one boot's batches as
// replays of the other's.
func NewV4() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40 // version 4
	buffer[8] = (buffer[8] & 0x3f) | 0x80 // RFC 4122 variant
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], buffer[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], buffer[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], buffer[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], buffer[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], buffer[10:16])
	return string(encoded), nil
}
