package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return hex.EncodeToString(b[0:4]) + "-" + hex.EncodeToString(b[4:6]) + "-" + hex.EncodeToString(b[6:8]) + "-" + hex.EncodeToString(b[8:10]) + "-" + hex.EncodeToString(b[10:16])
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (s *Server) signJWT(payload Object) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	message := header + "." + base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(s.Config.JWTSecret))
	mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func (s *Server) verifyJWT(token string) (Object, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid token")
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var h Object
	if err = json.Unmarshal(header, &h); err != nil || h["alg"] != "HS256" {
		return nil, errors.New("invalid algorithm")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, []byte(s.Config.JWTSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, errors.New("invalid signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var v Object
	if err = json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	if v["iss"] != s.Config.AccessTokenIssuer() || number(v, "exp") <= float64(time.Now().Unix()) || text(v, "sub") == "" || text(v, "sid") == "" {
		return nil, errors.New("invalid claims")
	}
	return v, nil
}
