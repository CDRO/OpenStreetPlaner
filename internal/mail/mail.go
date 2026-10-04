// Package mail verschickt schlichte Text-E-Mails über SMTP (net/smtp, ohne Fremdbibliothek):
// STARTTLS auf 587/25, implizites TLS auf 465, PLAIN-Anmeldung, wenn ein Benutzer gesetzt ist.
package mail

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// Sender verschickt eine Nachricht; Fehler kommen vom SMTP-Server.
type Sender interface {
	Send(to, subject, body string) error
}

type Config struct {
	Host     string
	Port     int
	User     string
	Password string
	From     string
}

// FromEnv liest SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD, SMTP_FROM; ohne Host kein Versand.
func FromEnv() (Config, bool) {
	host := strings.TrimSpace(os.Getenv("SMTP_HOST"))
	if host == "" {
		return Config{}, false
	}
	port, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("SMTP_PORT")))
	if port <= 0 {
		port = 587
	}
	from := strings.TrimSpace(os.Getenv("SMTP_FROM"))
	if from == "" {
		from = strings.TrimSpace(os.Getenv("SMTP_USER"))
	}
	return Config{Host: host, Port: port, User: os.Getenv("SMTP_USER"), Password: os.Getenv("SMTP_PASSWORD"), From: from}, true
}

type SMTP struct {
	cfg     Config
	Timeout time.Duration
	// InsecureTLS nur für Tests mit selbstsignierten Zertifikaten
	InsecureTLS bool
}

func New(cfg Config) (*SMTP, error) {
	if cfg.Host == "" || cfg.From == "" {
		return nil, errors.New("SMTP: Host und Absender (SMTP_HOST, SMTP_FROM) sind nötig")
	}
	if cfg.Port <= 0 {
		cfg.Port = 587
	}
	return &SMTP{cfg: cfg, Timeout: 20 * time.Second}, nil
}

func (s *SMTP) From() string { return s.cfg.From }

// Message baut die rohe Nachricht (Kopfzeilen und Base64-Text), damit Umlaute überall ankommen.
func Message(from, to, subject, body string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	b.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n")
	b.WriteString("Auto-Submitted: auto-generated\r\n")
	b.WriteString("\r\n")
	enc := base64.StdEncoding.EncodeToString([]byte(body))
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc + "\r\n")
	return []byte(b.String())
}

func (s *SMTP) Send(to, subject, body string) error {
	to = strings.TrimSpace(to)
	if to == "" || strings.ContainsAny(to, "\r\n") {
		return errors.New("SMTP: Empfänger fehlt oder ist ungültig")
	}
	addr := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	var conn net.Conn
	var err error
	dialer := &net.Dialer{Timeout: s.Timeout}
	tlsCfg := &tls.Config{ServerName: s.cfg.Host, InsecureSkipVerify: s.InsecureTLS} //nolint:gosec // nur für Tests schaltbar
	if s.cfg.Port == 465 {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("SMTP verbinden: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(s.Timeout))
	c, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("SMTP: %w", err)
	}
	defer c.Close()
	if s.cfg.Port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsCfg); err != nil {
				return fmt.Errorf("SMTP STARTTLS: %w", err)
			}
		}
	}
	if s.cfg.User != "" {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(smtp.PlainAuth("", s.cfg.User, s.cfg.Password, s.cfg.Host)); err != nil {
				return fmt.Errorf("SMTP Anmeldung: %w", err)
			}
		}
	}
	if err := c.Mail(s.cfg.From); err != nil {
		return fmt.Errorf("SMTP MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("SMTP RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA: %w", err)
	}
	if _, err := w.Write(Message(s.cfg.From, to, subject, body)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("SMTP senden: %w", err)
	}
	return c.Quit()
}
