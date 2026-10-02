// Package blobtest stellt einen kleinen S3-kompatiblen Testserver bereit (Get/Put/Delete/
// ListObjectsV2 im Pfad-Stil) und prüft die AWS-Signatur V4 jeder Anfrage mit eigener,
// unabhängiger Rechnung – damit die Signierung des Clients wirklich getestet ist.
package blobtest

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
)

type Server struct {
	*httptest.Server
	Bucket    string
	AccessKey string
	SecretKey string
	MaxKeys   int // Seitengrösse für List (Standard 1000)
	Fail      int // wenn > 0: die nächsten n Anfragen antworten mit 503 (Wiederholungen testen)
	mu        sync.Mutex
	objects   map[string][]byte
	Requests  []string // Methode + Pfad jeder Anfrage
}

func NewServer(bucket, accessKey, secretKey string) *Server {
	s := &Server{Bucket: bucket, AccessKey: accessKey, SecretKey: secretKey, MaxKeys: 1000, objects: map[string][]byte{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

// Objects liefert eine Kopie aller gespeicherten Objekte.
func (s *Server) Objects() map[string][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string][]byte, len(s.objects))
	for k, v := range s.objects {
		out[k] = append([]byte(nil), v...)
	}
	return out
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.Requests = append(s.Requests, r.Method+" "+r.URL.RequestURI())
	if s.Fail > 0 {
		s.Fail--
		s.mu.Unlock()
		http.Error(w, "<Error><Code>SlowDown</Code></Error>", http.StatusServiceUnavailable)
		return
	}
	s.mu.Unlock()
	if err := s.verify(r, body); err != nil {
		http.Error(w, "<Error><Code>SignatureDoesNotMatch</Code><Message>"+err.Error()+"</Message></Error>", http.StatusForbidden)
		return
	}
	path := strings.TrimPrefix(r.URL.EscapedPath(), "/")
	bucket, key, _ := strings.Cut(path, "/")
	if bucket != s.Bucket {
		http.Error(w, "<Error><Code>NoSuchBucket</Code></Error>", http.StatusNotFound)
		return
	}
	key, _ = url.PathUnescape(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && key == "":
		s.list(w, r)
	case r.Method == http.MethodGet:
		data, ok := s.objects[key]
		if !ok {
			http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
	case r.Method == http.MethodPut:
		s.objects[key] = append([]byte(nil), body...)
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodDelete:
		delete(s.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "<Error><Code>MethodNotAllowed</Code></Error>", http.StatusMethodNotAllowed)
	}
}

type listResult struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	Name                  string   `xml:"Name"`
	Prefix                string   `xml:"Prefix"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken,omitempty"`
	Contents              []struct {
		Key string `xml:"Key"`
	} `xml:"Contents"`
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("list-type") != "2" {
		http.Error(w, "<Error><Code>InvalidArgument</Code><Message>list-type=2 erwartet</Message></Error>", http.StatusBadRequest)
		return
	}
	prefix := q.Get("prefix")
	after := q.Get("continuation-token") // Token = letzter Schlüssel der vorigen Seite
	var keys []string
	for k := range s.objects {
		if strings.HasPrefix(k, prefix) && (after == "" || k > after) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	res := listResult{Name: s.Bucket, Prefix: prefix}
	max := s.MaxKeys
	if max <= 0 {
		max = 1000
	}
	if len(keys) > max {
		res.IsTruncated = true
		res.NextContinuationToken = keys[max-1]
		keys = keys[:max]
	}
	for _, k := range keys {
		res.Contents = append(res.Contents, struct {
			Key string `xml:"Key"`
		}{k})
	}
	w.Header().Set("Content-Type", "application/xml")
	xml.NewEncoder(w).Encode(res)
}

// verify rechnet die Signatur V4 aus der tatsächlichen Anfrage nach.
func (s *Server) verify(r *http.Request, body []byte) error {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") {
		return fmt.Errorf("Authorization fehlt")
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(auth, "AWS4-HMAC-SHA256 "), ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		fields[k] = v
	}
	cred := strings.Split(fields["Credential"], "/")
	if len(cred) != 5 || cred[0] != s.AccessKey || cred[2] == "" || cred[3] != "s3" || cred[4] != "aws4_request" {
		return fmt.Errorf("Credential unerwartet: %q", fields["Credential"])
	}
	amzDate := r.Header.Get("x-amz-date")
	if len(amzDate) != 16 || amzDate[:8] != cred[1] {
		return fmt.Errorf("x-amz-date passt nicht zum Credential-Datum")
	}
	sum := sha256.Sum256(body)
	if r.Header.Get("x-amz-content-sha256") != hex.EncodeToString(sum[:]) {
		return fmt.Errorf("Payload-Hash stimmt nicht")
	}
	signed := strings.Split(fields["SignedHeaders"], ";")
	var canonicalHeaders strings.Builder
	for _, h := range signed {
		val := r.Header.Get(h)
		if h == "host" {
			val = r.Host
		}
		canonicalHeaders.WriteString(h + ":" + strings.TrimSpace(val) + "\n")
	}
	// Query unabhängig kanonisieren: sortiert, RFC-3986-kodiert
	q := r.URL.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, encode(k)+"="+encode(v))
		}
	}
	canonicalRequest := strings.Join([]string{r.Method, r.URL.EscapedPath(), strings.Join(parts, "&"), canonicalHeaders.String(), fields["SignedHeaders"], hex.EncodeToString(sum[:])}, "\n")
	crHash := sha256.Sum256([]byte(canonicalRequest))
	scope := strings.Join(cred[1:], "/")
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, hex.EncodeToString(crHash[:])}, "\n")
	k := mac([]byte("AWS4"+s.SecretKey), cred[1])
	k = mac(k, cred[2])
	k = mac(k, "s3")
	k = mac(k, "aws4_request")
	want := hex.EncodeToString(mac(k, stringToSign))
	if want != fields["Signature"] {
		return fmt.Errorf("Signatur falsch")
	}
	return nil
}

func mac(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

func encode(s string) string {
	return strings.NewReplacer("+", "%20", "*", "%2A", "%7E", "~").Replace(url.QueryEscape(s))
}
