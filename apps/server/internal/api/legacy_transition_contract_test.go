package api

// Contract fixture only. Production automatic delivery remains blocked; do not
// ship a parallel inactive updater implementation in the runtime.

import (
	"crypto/ed25519"
	_ "embed"
	"encoding/base64"
	"strconv"
	"strings"
)

//go:embed assets/legacy-tauri-public-key.txt
var legacyTauriPublicKey string

type legacyContractManifest struct {
	releaseManifest
	LegacyTransitions []legacyTransitionAsset `json:"legacyTransitions,omitempty"`
}

type legacyTransitionAsset struct {
	releaseAsset
	Format    string `json:"format"`
	Signature string `json:"signature"`
}

// This validates the distinct old-key envelope and its signed trusted comment.
// Full payload verification is performed by the release packager and repeated
// by the old official updater. Checking for updates never downloads an installer.
func legacyEnvelope(signature, publicKey string) bool {
	if len(signature) == 0 || len(signature) > 8192 {
		return false
	}
	keyText, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKey))
	if err != nil {
		return false
	}
	sigText, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	keys := strings.Split(strings.TrimSpace(string(keyText)), "\n")
	lines := strings.Split(strings.TrimSpace(string(sigText)), "\n")
	if len(keys) != 2 || len(lines) != 4 || !strings.HasPrefix(lines[0], "untrusted comment:") || !strings.HasPrefix(lines[2], "trusted comment: ") {
		return false
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keys[1]))
	if err != nil || len(key) != 42 || string(key[:2]) != "Ed" {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[1]))
	if err != nil || len(sig) != 74 || string(sig[:2]) != "ED" || string(key[2:10]) != string(sig[2:10]) {
		return false
	}
	global, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[3]))
	if err != nil || len(global) != 64 {
		return false
	}
	message := append(append([]byte{}, sig[10:]...), []byte(strings.TrimPrefix(lines[2], "trusted comment: "))...)
	return ed25519.Verify(ed25519.PublicKey(key[10:]), message, global)
}

func transitionMatches(m legacyContractManifest, transition legacyTransitionAsset, key string) bool {
	if transition.Platform != "windows" || transition.Architecture != "x64" || transition.Format != "tauri-nsis-v1" || !strings.HasSuffix(transition.FileName, ".exe") || !legacyEnvelope(transition.Signature, key) {
		return false
	}
	for _, installer := range m.Installers {
		if installer == transition.releaseAsset {
			return true
		}
	}
	return false
}

func (s *Server) legacyProjection(m legacyContractManifest, current string, build int, key string) Object {
	if s.Config.GitHubRepository == "" {
		return nil
	}
	comparison, err := compareVersion(m.Version, current)
	if err != nil || comparison < 0 || (comparison == 0 && (build < 1 || m.Build <= build)) || len(m.LegacyTransitions) != 1 {
		return nil
	}
	asset := m.LegacyTransitions[0]
	if !transitionMatches(m, asset, key) {
		return nil
	}
	version := m.Version
	if build > 0 {
		version = strings.Split(m.Version, "+")[0] + "+" + strconv.Itoa(m.Build)
	}
	address := s.assetURL(m.releaseManifest, asset.releaseAsset)
	return Object{"version": version, "notes": strings.Join(m.Changelog, "\n"), "signature": asset.Signature, "fileSizeBytes": strconv.FormatInt(asset.SizeBytes, 10), "fileHash": asset.SHA256, "url": address, "originDownloadUrl": address}
}
