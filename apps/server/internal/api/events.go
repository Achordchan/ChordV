package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type replayEvent struct {
	id, target string
	data       Object
}
type eventHub struct {
	mu            sync.Mutex
	instance      string
	sequence      uint64
	subscriptions map[chan Object]string
	replay        []replayEvent
	sent          map[string]bool
}

func newEventHub() *eventHub {
	return &eventHub{instance: newID(), sent: map[string]bool{}, subscriptions: map[chan Object]string{}}
}
func (h *eventHub) subscribe(target string) (chan Object, func()) {
	ch := make(chan Object, 64)
	h.mu.Lock()
	h.subscriptions[ch] = target
	h.mu.Unlock()
	return ch, func() { h.mu.Lock(); delete(h.subscriptions, ch); h.mu.Unlock() }
}
func eventMatches(target, user string) bool {
	if user == "" || target == user {
		return true
	}
	return target == "admin" && !strings.HasPrefix(user, "agent:") && !strings.HasPrefix(user, "traffic-reset:")
}
func (h *eventHub) publish(user string, event Object) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sequence++
	id := h.instance + ":" + strconv.FormatUint(h.sequence, 10)
	copy := Object{}
	for key, value := range event {
		copy[key] = value
	}
	copy["_eventId"] = id
	h.replay = append(h.replay, replayEvent{id: id, target: user, data: copy})
	if len(h.replay) > 512 {
		h.replay = h.replay[len(h.replay)-512:]
	}
	for ch, target := range h.subscriptions {
		if !eventMatches(target, user) {
			continue
		}
		select {
		case ch <- copy:
		default:
			// The ring retains the real events. A slow reader receives an explicit gap
			// signal instead of silently losing a revocation; SSE replays or resyncs.
			draining := true
			for draining {
				select {
				case <-ch:
				default:
					draining = false
				}
			}
			ch <- Object{"_resync": true}
		}
	}
}
func (h *eventHub) since(target, lastID string) ([]Object, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	found := lastID == h.instance+":0" && (len(h.replay) == 0 || h.replay[0].id == h.instance+":1")
	out := []Object{}
	for _, entry := range h.replay {
		if found && eventMatches(target, entry.target) {
			out = append(out, entry.data)
		}
		if entry.id == lastID {
			found = true
		}
	}
	return out, found
}
func (s *Server) changed(section, userID string) {
	kind := "subscription_updated"
	switch section {
	case "users":
		kind = "account_updated"
	case "nodes":
		kind = "node_access_updated"
	case "announcements":
		kind = "announcement_updated"
	case "policies":
		kind = "policy_updated"
	case "tickets":
		kind = "ticket_updated"
	case "imageBed":
		kind = "image_bed_updated"
	}
	if section == "users" || section == "subscriptions" || section == "teams" || section == "nodes" {
		s.publishRecentRevocations(userID)
	}
	s.events.publish(userID, Object{"type": kind, "occurredAt": now()})
}
func fullSyncEvents(admin bool) []Object {
	kinds := []string{"account_updated", "subscription_updated", "node_access_updated", "announcement_updated", "policy_updated", "ticket_updated"}
	if admin {
		kinds = append(kinds, "image_bed_updated", "sync_queue_updated", "presence_updated")
	}
	out := []Object{}
	for _, kind := range kinds {
		out = append(out, Object{"type": kind, "occurredAt": now()})
	}
	return out
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, fail(500, "当前连接不支持事件推送")
	}
	target := text(user, "id")
	admin := user["role"] == "admin" && r.URL.Path == "/api/admin/events/stream"
	if admin {
		target = "admin"
	}
	if !admin {
		if err := s.notePresence(r.Context(), text(user, "id"), false); err != nil {
			return nil, err
		}
	}
	ch, unsubscribe := s.events.subscribe(target)
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()
	lastID := r.Header.Get("Last-Event-ID")
	controller := http.NewResponseController(w)
	send := func(event Object) error {
		if _, err := s.authenticate(r); err != nil {
			return err
		}
		if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil && err != http.ErrNotSupported {
			return err
		}
		if id := text(event, "_eventId"); id != "" && lastID != "" && event["_resetCursor"] != true {
			prefix, sequence, ok := strings.Cut(id, ":")
			lastPrefix, lastSequence, lastOK := strings.Cut(lastID, ":")
			if ok && lastOK && prefix == lastPrefix {
				current, _ := strconv.ParseUint(sequence, 10, 64)
				previous, _ := strconv.ParseUint(lastSequence, 10, 64)
				if current <= previous {
					return nil
				}
			}
		}
		data := Object{}
		for key, value := range event {
			if key != "_eventId" && key != "_resync" && key != "_resetCursor" {
				data[key] = value
			}
		}
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if id := text(event, "_eventId"); id != "" {
			if _, err = fmt.Fprintf(w, "id: %s\n", id); err != nil {
				return err
			}
			lastID = id
		}
		if _, err = fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	syncAll := func(reason string) error {
		cursor := s.events.cursor()
		if admin {
			if err := send(Object{"type": "resync", "reason": reason, "occurredAt": now(), "_eventId": cursor, "_resetCursor": true}); err != nil {
				return err
			}
		}
		events := fullSyncEvents(admin)
		for index, event := range events {
			if index == len(events)-1 {
				event["_eventId"] = cursor
				event["_resetCursor"] = true
			}
			if err := send(event); err != nil {
				return err
			}
		}
		return nil
	}
	syncStream := func(opening bool) error {
		if lastID != "" {
			events, found := s.events.since(target, lastID)
			if !found {
				return syncAll("replay_gap")
			}
			for _, event := range events {
				if err := send(event); err != nil {
					return err
				}
			}
		} else if !opening {
			return syncAll("replay_gap")
		}
		if opening {
			return syncAll("connected")
		}
		return nil
	}
	if err := syncStream(true); err != nil {
		return nil, nil
	}

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.resyncStop:
			return nil, nil
		case <-r.Context().Done():
			return nil, nil
		case event := <-ch:
			if event["_resync"] == true {
				if err := syncStream(false); err != nil {
					return nil, nil
				}
				continue
			}
			if err := send(event); err != nil {
				return nil, nil
			}
		case <-ticker.C:
			if !admin && r.URL.Query().Get("presence") != "ping" {
				if err := s.notePresence(r.Context(), text(user, "id"), false); err != nil {
					return nil, nil
				}
			}
			if err := send(Object{"type": "keepalive", "occurredAt": now()}); err != nil {
				return nil, nil
			}
		}
	}
}

func (h *eventHub) cursor() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.instance + ":" + strconv.FormatUint(h.sequence, 10)
}
