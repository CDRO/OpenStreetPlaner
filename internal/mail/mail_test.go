package mail

import (
	"bufio"
	"encoding/base64"
	"net"
	"strings"
	"testing"
)

// Winziger SMTP-Server: nimmt eine Nachricht an und merkt sich Umschlag und Inhalt.
func fakeSMTP(t *testing.T) (addr string, got chan map[string]string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	got = make(chan map[string]string, 1)
	go func() {
		defer ln.Close()
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		w := func(s string) { conn.Write([]byte(s + "\r\n")) }
		w("220 fake ESMTP")
		msg := map[string]string{}
		var data strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if inData {
				if line == "." {
					inData = false
					msg["data"] = data.String()
					w("250 OK queued")
					continue
				}
				data.WriteString(line + "\n")
				continue
			}
			cmd := strings.ToUpper(line)
			switch {
			case strings.HasPrefix(cmd, "EHLO"):
				w("250-fake")
				w("250-AUTH PLAIN")
				w("250 OK")
			case strings.HasPrefix(cmd, "AUTH PLAIN"):
				raw, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(line[len("AUTH PLAIN"):]))
				msg["auth"] = strings.ReplaceAll(string(raw), "\x00", "|")
				w("235 ok")
			case strings.HasPrefix(cmd, "MAIL FROM:"):
				msg["from"] = strings.TrimSpace(line[len("MAIL FROM:"):])
				w("250 OK")
			case strings.HasPrefix(cmd, "RCPT TO:"):
				msg["to"] = strings.TrimSpace(line[len("RCPT TO:"):])
				w("250 OK")
			case cmd == "DATA":
				inData = true
				w("354 go")
			case cmd == "QUIT":
				w("221 bye")
				got <- msg
				return
			default:
				w("250 OK")
			}
		}
	}()
	return ln.Addr().String(), got
}

func TestSendPlainOverFakeServer(t *testing.T) {
	addr, got := fakeSMTP(t)
	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}
	s, err := New(Config{Host: host, Port: port, User: "nutzer", Password: "pw", From: "stadtplaner@example.org"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send("tizian@example.org", "Entwurf „Dorf“ läuft ab", "Grüezi\nSichern bitte.\n"); err != nil {
		t.Fatal(err)
	}
	msg := <-got
	if msg["from"] != "<stadtplaner@example.org>" || msg["to"] != "<tizian@example.org>" {
		t.Fatalf("Umschlag: %+v", msg)
	}
	if msg["auth"] != "|nutzer|pw" {
		t.Fatalf("AUTH PLAIN: %q", msg["auth"])
	}
	data := msg["data"]
	if !strings.Contains(data, "Subject: =?utf-8?q?") || !strings.Contains(data, "Content-Type: text/plain; charset=utf-8") || !strings.Contains(data, "To: tizian@example.org") {
		t.Fatalf("Kopfzeilen: %s", data)
	}
	body := data[strings.Index(data, "\n\n")+2:]
	raw, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(body, "\n", ""))
	if err != nil || string(raw) != "Grüezi\nSichern bitte.\n" {
		t.Fatalf("Text: %v %q", err, raw)
	}
	if _, err := New(Config{}); err == nil {
		t.Fatal("ohne Host darf es keinen Sender geben")
	}
	if err := s.Send("", "x", "y"); err == nil {
		t.Fatal("leerer Empfänger")
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv("SMTP_HOST", "")
	if _, ok := FromEnv(); ok {
		t.Fatal("ohne SMTP_HOST aus")
	}
	t.Setenv("SMTP_HOST", "mail.example.org")
	t.Setenv("SMTP_USER", "u@example.org")
	t.Setenv("SMTP_FROM", "")
	cfg, ok := FromEnv()
	if !ok || cfg.Port != 587 || cfg.From != "u@example.org" {
		t.Fatalf("Standardwerte: %+v", cfg)
	}
}
