package push

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := b64.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Testvektor aus RFC 8291, Anhang A.
func TestEncryptMatchesRFC8291Vector(t *testing.T) {
	plaintext := []byte("When I grow up, I want to be a watermelon")
	uaPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
	if err != nil {
		t.Fatal(err)
	}
	uaPub := mustB64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	auth := mustB64(t, "BTBZMqHH6r4Tts7J_aSIgg")
	asPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	salt := mustB64(t, "DGv6ra1nlYgDCS1FRnbzlw")
	body, err := Encrypt(plaintext, uaPub, auth, asPriv, salt)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if got := b64.EncodeToString(body); got != want {
		t.Fatalf("Chiffrat weicht vom RFC-Vektor ab:\n got %s\nwant %s", got, want)
	}
	back, err := Decrypt(body, uaPriv, auth)
	if err != nil || string(back) != string(plaintext) {
		t.Fatalf("Decrypt: %v %q", err, back)
	}
}

func TestEncryptRandomRoundTripAndLimits(t *testing.T) {
	uaPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := []byte("0123456789abcdef")
	body, err := Encrypt([]byte(`{"title":"Hallo"}`), uaPriv.PublicKey().Bytes(), auth, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	back, err := Decrypt(body, uaPriv, auth)
	if err != nil || string(back) != `{"title":"Hallo"}` {
		t.Fatalf("Roundtrip: %v %q", err, back)
	}
	if _, err := Encrypt(make([]byte, maxPayload+1), uaPriv.PublicKey().Bytes(), auth, nil, nil); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("zu gross nicht erkannt: %v", err)
	}
	if _, err := Encrypt([]byte("x"), []byte{1, 2, 3}, auth, nil, nil); !errors.Is(err, ErrBadSub) {
		t.Fatalf("kaputter Schlüssel nicht erkannt: %v", err)
	}
}

func TestVapidHeaderVerifies(t *testing.T) {
	keys, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	h, err := keys.VapidHeader("https://push.example.org/send/abc", "mailto:test@example.org", time.Unix(1_800_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "vapid t=") || !strings.Contains(h, ", k="+keys.PublicKey) {
		t.Fatalf("Header-Form: %s", h)
	}
	jwt := strings.TrimPrefix(strings.Split(h, ", k=")[0], "vapid t=")
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT-Teile: %d", len(parts))
	}
	var claims map[string]any
	_ = json.Unmarshal(mustB64(t, parts[1]), &claims)
	if claims["aud"] != "https://push.example.org" || claims["sub"] != "mailto:test@example.org" || claims["exp"].(float64) != 1_800_000_000+12*3600 {
		t.Fatalf("Claims: %+v", claims)
	}
	pubBytes := mustB64(t, keys.PublicKey)
	x, y := elliptic.Unmarshal(elliptic.P256(), pubBytes) //nolint:staticcheck
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}
	sig := mustB64(t, parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatalf("Signatur ungültig")
	}
	if _, err := keys.VapidHeader("nicht-eine-url", "mailto:x", time.Now()); err == nil {
		t.Fatalf("ungültiger Endpunkt akzeptiert")
	}
}

func TestSenderAgainstFakePushService(t *testing.T) {
	uaPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := []byte("0123456789abcdef")
	var got []byte
	var headers http.Header
	status := 201
	svc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		buf := make([]byte, 8192)
		n, _ := r.Body.Read(buf)
		got = buf[:n]
		w.WriteHeader(status)
	}))
	defer svc.Close()
	keys, _ := GenerateKeys()
	sender := NewSender(keys, "mailto:test@example.org")
	var sub Subscription
	sub.Endpoint = svc.URL + "/push/1"
	sub.Keys.P256dh = b64.EncodeToString(uaPriv.PublicKey().Bytes())
	sub.Keys.Auth = b64.EncodeToString(auth)
	if !ValidSubscription(sub) {
		t.Fatalf("Test-Abonnement sollte gültig sein")
	}
	if err := sender.Send(context.Background(), sub, []byte(`{"title":"Neuer Kommentar"}`)); err != nil {
		t.Fatal(err)
	}
	if headers.Get("Content-Encoding") != "aes128gcm" || headers.Get("TTL") != "86400" || !strings.HasPrefix(headers.Get("Authorization"), "vapid t=") {
		t.Fatalf("Header: %+v", headers)
	}
	back, err := Decrypt(got, uaPriv, auth)
	if err != nil || string(back) != `{"title":"Neuer Kommentar"}` {
		t.Fatalf("Empfänger kann nicht entschlüsseln: %v %q", err, back)
	}
	status = 410
	if err := sender.Send(context.Background(), sub, []byte("x")); !errors.Is(err, ErrGone) {
		t.Fatalf("410 sollte ErrGone sein: %v", err)
	}
	status = 500
	if err := sender.Send(context.Background(), sub, []byte("x")); err == nil || errors.Is(err, ErrGone) {
		t.Fatalf("500 sollte ein anderer Fehler sein: %v", err)
	}
	sub.Endpoint = "http://evil.example/x"
	if ValidSubscription(sub) {
		t.Fatalf("http-Endpunkt darf nicht gültig sein")
	}
}

func TestLoadOrCreateKeysPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vapid.json")
	a, err := LoadOrCreateKeys(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreateKeys(path)
	if err != nil || a != b {
		t.Fatalf("Schlüssel nicht persistent: %v %+v %+v", err, a, b)
	}
	if len(mustB64(t, a.PublicKey)) != 65 || len(mustB64(t, a.PrivateKey)) != 32 {
		t.Fatalf("Schlüssellängen: %+v", a)
	}
}
