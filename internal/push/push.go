// Package push versendet Web-Push-Nachrichten ohne Fremdbibliothek:
// Nutzdaten werden nach RFC 8291 (ECDH P-256, HKDF, AES-128-GCM, Content-
// Encoding aes128gcm nach RFC 8188) verschlüsselt und die Anfrage nach
// RFC 8292 (VAPID, ES256-JWT) signiert.
package push

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	recordSize = 4096
	maxPayload = 3993 // 4096 - 16 (Tag) - 86 (Header) - 1 (Delimiter)
)

var (
	ErrGone       = errors.New("Abonnement existiert nicht mehr")
	ErrBadSub     = errors.New("ungültiges Abonnement")
	ErrTooLarge   = errors.New("Nachricht zu gross")
	b64           = base64.RawURLEncoding
	infoAuth      = []byte("WebPush: info\x00")
	infoCEK       = []byte("Content-Encoding: aes128gcm\x00")
	infoNonce     = []byte("Content-Encoding: nonce\x00")
	defaultClient = &http.Client{Timeout: 15 * time.Second}
)

// Subscription entspricht dem PushSubscription-JSON des Browsers.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// Keys sind das VAPID-Schlüsselpaar des Servers.
type Keys struct {
	PrivateKey string `json:"privateKey"` // base64url, 32 Byte Skalar
	PublicKey  string `json:"publicKey"`  // base64url, 65 Byte unkomprimierter Punkt
}

func GenerateKeys() (Keys, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Keys{}, err
	}
	d := make([]byte, 32)
	priv.D.FillBytes(d)
	pub := elliptic.Marshal(elliptic.P256(), priv.X, priv.Y) //nolint:staticcheck // unkomprimierter Punkt ist das Web-Push-Format
	return Keys{PrivateKey: b64.EncodeToString(d), PublicKey: b64.EncodeToString(pub)}, nil
}

// LoadOrCreateKeys liest das Schlüsselpaar aus path oder legt es neu an.
func LoadOrCreateKeys(path string) (Keys, error) {
	var k Keys
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &k); err == nil && k.PrivateKey != "" && k.PublicKey != "" {
			return k, nil
		}
	}
	k, err = GenerateKeys()
	if err != nil {
		return Keys{}, err
	}
	data, _ = json.MarshalIndent(k, "", "  ")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return Keys{}, err
	}
	return k, nil
}

func (k Keys) ecdsaPrivate() (*ecdsa.PrivateKey, error) {
	d, err := b64.DecodeString(k.PrivateKey)
	if err != nil || len(d) != 32 {
		return nil, errors.New("VAPID-Privatschlüssel ungültig")
	}
	priv := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256()}, D: new(big.Int).SetBytes(d)}
	priv.X, priv.Y = priv.Curve.ScalarBaseMult(d) //nolint:staticcheck
	return priv, nil
}

// hkdf nach RFC 5869 mit SHA-256.
func hkdf(salt, ikm, info []byte, length int) []byte {
	ext := hmac.New(sha256.New, salt)
	ext.Write(ikm)
	prk := ext.Sum(nil)
	var out []byte
	var prev []byte
	for i := byte(1); len(out) < length; i++ {
		h := hmac.New(sha256.New, prk)
		h.Write(prev)
		h.Write(info)
		h.Write([]byte{i})
		prev = h.Sum(nil)
		out = append(out, prev...)
	}
	return out[:length]
}

// Encrypt verschlüsselt plaintext für den Empfänger (RFC 8291). serverPriv und
// salt sind optional (nil = zufällig) und dienen den Tests mit Vektoren.
func Encrypt(plaintext []byte, receiverPub, authSecret []byte, serverPriv *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(plaintext) > maxPayload {
		return nil, ErrTooLarge
	}
	if len(authSecret) != 16 {
		return nil, fmt.Errorf("%w: auth muss 16 Byte lang sein", ErrBadSub)
	}
	curve := ecdh.P256()
	uaPub, err := curve.NewPublicKey(receiverPub)
	if err != nil {
		return nil, fmt.Errorf("%w: p256dh: %v", ErrBadSub, err)
	}
	if serverPriv == nil {
		if serverPriv, err = curve.GenerateKey(rand.Reader); err != nil {
			return nil, err
		}
	}
	if salt == nil {
		salt = make([]byte, 16)
		if _, err := io.ReadFull(rand.Reader, salt); err != nil {
			return nil, err
		}
	}
	shared, err := serverPriv.ECDH(uaPub)
	if err != nil {
		return nil, err
	}
	asPub := serverPriv.PublicKey().Bytes()
	info := append(append(append([]byte{}, infoAuth...), receiverPub...), asPub...)
	ikm := hkdf(authSecret, shared, info, 32)
	cek := hkdf(salt, ikm, infoCEK, 16)
	nonce := hkdf(salt, ikm, infoNonce, 12)
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	padded := append(append([]byte{}, plaintext...), 0x02)
	ciphertext := gcm.Seal(nil, nonce, padded, nil)
	var out bytes.Buffer
	out.Write(salt)
	_ = binary.Write(&out, binary.BigEndian, uint32(recordSize))
	out.WriteByte(byte(len(asPub)))
	out.Write(asPub)
	out.Write(ciphertext)
	return out.Bytes(), nil
}

// Decrypt ist das Gegenstück für Tests (der Browser macht das sonst).
func Decrypt(body []byte, receiverPriv *ecdh.PrivateKey, authSecret []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, errors.New("zu kurz")
	}
	salt := body[:16]
	idLen := int(body[20])
	if len(body) < 21+idLen+16 {
		return nil, errors.New("zu kurz")
	}
	asPubBytes := body[21 : 21+idLen]
	ciphertext := body[21+idLen:]
	asPub, err := ecdh.P256().NewPublicKey(asPubBytes)
	if err != nil {
		return nil, err
	}
	shared, err := receiverPriv.ECDH(asPub)
	if err != nil {
		return nil, err
	}
	uaPub := receiverPriv.PublicKey().Bytes()
	info := append(append(append([]byte{}, infoAuth...), uaPub...), asPubBytes...)
	ikm := hkdf(authSecret, shared, info, 32)
	cek := hkdf(salt, ikm, infoCEK, 16)
	nonce := hkdf(salt, ikm, infoNonce, 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	padded, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	i := bytes.LastIndexByte(padded, 0x02)
	if i < 0 {
		return nil, errors.New("Padding-Trennzeichen fehlt")
	}
	return padded[:i], nil
}

// VapidHeader baut den Authorization-Header für einen Endpunkt (RFC 8292).
func (k Keys) VapidHeader(endpoint, subject string, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%w: Endpunkt", ErrBadSub)
	}
	priv, err := k.ecdsaPrivate()
	if err != nil {
		return "", err
	}
	header := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{
		"aud": u.Scheme + "://" + u.Host,
		"exp": now.Add(12 * time.Hour).Unix(),
		"sub": subject,
	})
	signing := header + "." + b64.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + signing + "." + b64.EncodeToString(sig) + ", k=" + k.PublicKey, nil
}

// Sender schickt verschlüsselte Nachrichten an Push-Dienste.
type Sender struct {
	Keys    Keys
	Subject string // mailto:… oder https://…
	Client  *http.Client
	TTL     int
}

func NewSender(keys Keys, subject string) *Sender {
	if subject == "" {
		subject = "https://github.com/CDRO/OpenStreetPlaner"
	}
	return &Sender{Keys: keys, Subject: subject, Client: defaultClient, TTL: 86400}
}

// Send verschlüsselt payload und liefert ErrGone, wenn der Dienst das Abonnement nicht mehr kennt.
func (s *Sender) Send(ctx context.Context, sub Subscription, payload []byte) error {
	pub, err := b64.DecodeString(sub.Keys.P256dh)
	if err != nil {
		return fmt.Errorf("%w: p256dh", ErrBadSub)
	}
	auth, err := b64.DecodeString(sub.Keys.Auth)
	if err != nil {
		return fmt.Errorf("%w: auth", ErrBadSub)
	}
	body, err := Encrypt(payload, pub, auth, nil, nil)
	if err != nil {
		return err
	}
	vapid, err := s.Keys.VapidHeader(sub.Endpoint, s.Subject, time.Now())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", fmt.Sprint(s.TTL))
	req.Header.Set("Urgency", "normal")
	req.Header.Set("Authorization", vapid)
	client := s.Client
	if client == nil {
		client = defaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	switch {
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
		return ErrGone
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	default:
		return fmt.Errorf("Push-Dienst antwortet mit %d", res.StatusCode)
	}
}

// ValidSubscription prüft die Felder grob (Endpunkt https, Schlüssel dekodierbar).
func ValidSubscription(sub Subscription) bool {
	u, err := url.Parse(sub.Endpoint)
	if err != nil || (u.Scheme != "https" && !strings.HasPrefix(sub.Endpoint, "http://127.0.0.1") && !strings.HasPrefix(sub.Endpoint, "http://localhost")) || u.Host == "" {
		return false
	}
	pub, err := b64.DecodeString(sub.Keys.P256dh)
	if err != nil || len(pub) != 65 {
		return false
	}
	auth, err := b64.DecodeString(sub.Keys.Auth)
	return err == nil && len(auth) == 16
}
