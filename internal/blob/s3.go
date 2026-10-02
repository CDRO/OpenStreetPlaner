package blob

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// S3Config beschreibt einen S3-kompatiblen Bucket (AWS Signature V4, Pfad-Stil).
type S3Config struct {
	Endpoint  string // z. B. https://cz41.objects.nineapis.ch
	Bucket    string
	Region    string // bei Nine immer us-east-1
	AccessKey string
	SecretKey string
	Prefix    string // optionaler Schlüssel-Präfix, z. B. "stadtplaner/"
	Client    *http.Client
}

// S3FromEnv liest die Bucket-Konfiguration aus der Umgebung. Gesetztes S3_BUCKET schaltet
// das Backend ein. Schlüssel: S3_ACCESS_KEY oder AWS_ACCESS_KEY_ID, S3_SECRET_KEY oder
// AWS_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION oder AWS_REGION (Standard us-east-1), S3_PREFIX.
func S3FromEnv() (S3Config, bool) {
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := strings.TrimSpace(os.Getenv(k)); v != "" {
				return v
			}
		}
		return ""
	}
	bucket := first("S3_BUCKET")
	if bucket == "" {
		return S3Config{}, false
	}
	return S3Config{
		Endpoint:  first("S3_ENDPOINT"),
		Bucket:    bucket,
		Region:    first("S3_REGION", "AWS_REGION"),
		AccessKey: first("S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID"),
		SecretKey: first("S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"),
		Prefix:    first("S3_PREFIX"),
	}, true
}

// S3 ist ein kleiner Client für Get/Put/Delete/List mit Signature V4 – ohne SDK.
type S3 struct {
	cfg      S3Config
	endpoint *url.URL
	client   *http.Client
	now      func() time.Time
}

func NewS3(cfg S3Config) (*S3, error) {
	if cfg.Bucket == "" || cfg.Endpoint == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, errors.New("S3: Bucket, Endpunkt, Access Key und Secret Key sind nötig (S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY)")
	}
	if !strings.Contains(cfg.Endpoint, "://") {
		cfg.Endpoint = "https://" + cfg.Endpoint
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("S3: ungültiger Endpunkt %q", cfg.Endpoint)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery, u.Fragment = "", ""
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	if cfg.Prefix != "" && !strings.HasSuffix(cfg.Prefix, "/") {
		cfg.Prefix += "/"
	}
	cfg.Prefix = strings.TrimLeft(cfg.Prefix, "/")
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &S3{cfg: cfg, endpoint: u, client: client, now: time.Now}, nil
}

func (s *S3) Bucket() string   { return s.cfg.Bucket }
func (s *S3) Endpoint() string { return s.endpoint.String() }

func (s *S3) Get(key string) ([]byte, error) {
	if !ValidKey(key) {
		return nil, fmt.Errorf("ungültiger Schlüssel %q", key)
	}
	resp, body, err := s.do(http.MethodGet, s.objectPath(key), nil, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotExist
	}
	if resp.StatusCode != http.StatusOK {
		return nil, s3Error("GET", key, resp, body)
	}
	return body, nil
}

func (s *S3) Put(key string, data []byte) error {
	if !ValidKey(key) {
		return fmt.Errorf("ungültiger Schlüssel %q", key)
	}
	resp, body, err := s.do(http.MethodPut, s.objectPath(key), nil, data)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return s3Error("PUT", key, resp, body)
	}
	return nil
}

func (s *S3) Delete(key string) error {
	if !ValidKey(key) {
		return fmt.Errorf("ungültiger Schlüssel %q", key)
	}
	resp, body, err := s.do(http.MethodDelete, s.objectPath(key), nil, nil)
	if err != nil {
		return err
	}
	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent, http.StatusNotFound:
		return nil
	}
	return s3Error("DELETE", key, resp, body)
}

type listResult struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		Key string `xml:"Key"`
	} `xml:"Contents"`
}

// List holt alle Schlüssel mit Präfix (ListObjectsV2, seitenweise) ohne den konfigurierten Präfix.
func (s *S3) List(prefix string) ([]string, error) {
	var out []string
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {s.cfg.Prefix + prefix}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		resp, body, err := s.do(http.MethodGet, "/"+s.cfg.Bucket, q, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, s3Error("LIST", prefix, resp, body)
		}
		var res listResult
		if err := xml.Unmarshal(body, &res); err != nil {
			return nil, fmt.Errorf("S3 LIST: Antwort unlesbar: %w", err)
		}
		for _, c := range res.Contents {
			out = append(out, strings.TrimPrefix(c.Key, s.cfg.Prefix))
		}
		if !res.IsTruncated || res.NextContinuationToken == "" {
			break
		}
		token = res.NextContinuationToken
	}
	sort.Strings(out)
	return out, nil
}

func (s *S3) objectPath(key string) string {
	return "/" + s.cfg.Bucket + "/" + uriEncode(s.cfg.Prefix+key, false)
}

func s3Error(op, key string, resp *http.Response, body []byte) error {
	msg := strings.TrimSpace(string(body))
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	return fmt.Errorf("S3 %s %s: HTTP %d %s", op, key, resp.StatusCode, msg)
}

// do schickt eine signierte Anfrage; vorübergehende Fehler (Netz, 5xx) werden bis zu dreimal wiederholt.
func (s *S3) do(method, path string, query url.Values, body []byte) (*http.Response, []byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 300 * time.Millisecond)
		}
		req, err := s.newRequest(method, path, query, body)
		if err != nil {
			return nil, nil, err
		}
		resp, err := s.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode >= 500 {
			lastErr = s3Error(method, path, resp, data)
			continue
		}
		return resp, data, nil
	}
	return nil, nil, fmt.Errorf("S3 %s %s: %w", method, path, lastErr)
}

// newRequest baut die Anfrage mit AWS Signature V4 (Header-Variante, signierter Payload-Hash).
func (s *S3) newRequest(method, path string, query url.Values, body []byte) (*http.Request, error) {
	canonicalQuery := canonicalQueryString(query)
	u := *s.endpoint
	u.RawPath = s.endpoint.Path + path
	u.Path = s.endpoint.Path + path
	if p, err := url.PathUnescape(u.RawPath); err == nil {
		u.Path = p
	}
	u.RawQuery = canonicalQuery
	req, err := http.NewRequest(method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	amzDate := now.Format("20060102T150405Z")
	date := amzDate[:8]
	payloadHash := sha256Hex(body)
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/json")
	}
	canonicalHeaders := "host:" + u.Host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{method, u.RawPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash}, "\n")
	scope := date + "/" + s.cfg.Region + "/s3/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest))}, "\n")
	kDate := hmacSHA256([]byte("AWS4"+s.cfg.SecretKey), date)
	kRegion := hmacSHA256(kDate, s.cfg.Region)
	kService := hmacSHA256(kRegion, "s3")
	kSigning := hmacSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.cfg.AccessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
	return req, nil
}

func canonicalQueryString(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, uriEncode(k, true)+"="+uriEncode(v, true))
		}
	}
	return strings.Join(parts, "&")
}

// uriEncode nach AWS: alles ausser A–Z a–z 0–9 - _ . ~ wird prozentkodiert; "/" nur, wenn encodeSlash.
func uriEncode(s string, encodeSlash bool) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&15])
		}
	}
	return b.String()
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}
