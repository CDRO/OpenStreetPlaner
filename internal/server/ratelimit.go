package server

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// limiter ist ein Token-Bucket pro Client-Adresse für schreibende API-Aufrufe.
type limiter struct {
	mu         sync.Mutex
	rate       float64 // Tokens pro Sekunde
	burst      float64
	trustProxy bool
	buckets    map[string]*bucket
	lastSweep  time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(perMinute float64, burst int, trustProxy bool) *limiter {
	return &limiter{rate: perMinute / 60, burst: float64(burst), trustProxy: trustProxy, buckets: map[string]*bucket{}, lastSweep: time.Now()}
}

func (l *limiter) clientIP(r *http.Request) string {
	if l.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.lastSweep) > 10*time.Minute {
		for k, b := range l.buckets {
			if now.Sub(b.last) > 10*time.Minute {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// middleware begrenzt POST/PUT/PATCH/DELETE unter /api/.
func (l *limiter) middleware(next http.Handler) http.Handler {
	if l == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !l.allow(l.clientIP(r)) {
				w.Header().Set("Retry-After", "10")
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Zu viele Anfragen, bitte kurz warten"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
