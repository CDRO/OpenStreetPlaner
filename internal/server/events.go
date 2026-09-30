package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// broker verteilt Ereignisse eines Entwurfs an offene Event-Streams (SSE).
type broker struct {
	mu   sync.Mutex
	subs map[string]map[chan []byte]struct{}
}

func newBroker() *broker { return &broker{subs: map[string]map[chan []byte]struct{}{}} }

func (b *broker) subscribe(id string) chan []byte {
	ch := make(chan []byte, 16)
	b.mu.Lock()
	if b.subs[id] == nil {
		b.subs[id] = map[chan []byte]struct{}{}
	}
	b.subs[id][ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *broker) unsubscribe(id string, ch chan []byte) {
	b.mu.Lock()
	if set := b.subs[id]; set != nil {
		delete(set, ch)
		if len(set) == 0 {
			delete(b.subs, id)
		}
	}
	b.mu.Unlock()
}

// publish schickt ein Ereignis; langsame Empfänger verlieren es (kein Blockieren).
func (b *broker) publish(id, event string, payload any) {
	data, _ := json.Marshal(payload)
	msg := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, data))
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs[id] {
		select {
		case ch <- msg:
		default:
		}
	}
}

// events streamt Änderungen eines Entwurfs als Server-Sent Events.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	id, err := draftID(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if _, _, err := s.store.Get(id); err != nil {
		writeError(w, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming nicht unterstützt", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()
	ch := s.broker.subscribe(id)
	defer s.broker.unsubscribe(id, ch)
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
