package proxy

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"

	"github.com/e2b-dev/infra/packages/shared/pkg/logger"
)

// Embed-token middleware. Verifies the Hive-minted HS256 JWT before letting
// any sandbox-subdomain request reach the host-header router. The JWT travels
// in the URL of the embed payload returned by hive-backend's
// `/v1/workspace/start`:
//
//	loadUrl     ...?access_token=<jwt>      (iframe initial nav)
//	websocketUrl ...?token=<jwt>            (noVNC websockify upgrade)
//
// On the first verified hit we drop a same-origin cookie scoped to the sandbox
// subdomain so subsequent asset loads (rfb.js, css, ...) inside the iframe
// don't have to carry the query param. Cookie expiry mirrors the JWT exp.
//
// Apex hits (`vm.open-hive.com` itself, no `<port>-<id>` label) are passed
// through untouched — those go to client-proxy's existing 4xx handler.

const (
	embedTokenCookieName  = "hive_embed_token"
	embedTokenClaimKind   = "hive-workspace-embed"
	embedTokenQueryParam  = "access_token"
	embedTokenAltQuery    = "token"
)

// EmbedTokenMiddleware returns an http middleware that verifies a JWT on
// sandbox-subdomain requests. If secret is empty the middleware is a no-op
// (intended for local dev where hive-backend isn't minting embed tokens).
func EmbedTokenMiddleware(secret string) func(http.Handler) http.Handler {
	if secret == "" {
		return func(next http.Handler) http.Handler { return next }
	}
	key := []byte(secret)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			// Extract the leftmost label of the host: "<port>-<sandboxId>".
			label, ok := leftmostHostLabel(r.Host)
			if !ok {
				// Apex or malformed host — let the inner handler answer.
				next.ServeHTTP(w, r)
				return
			}
			dash := strings.IndexByte(label, '-')
			if dash <= 0 || dash == len(label)-1 {
				next.ServeHTTP(w, r)
				return
			}
			expectedSandboxID := label[dash+1:]

			tokenStr := r.URL.Query().Get(embedTokenQueryParam)
			if tokenStr == "" {
				tokenStr = r.URL.Query().Get(embedTokenAltQuery)
			}
			if tokenStr == "" {
				if c, err := r.Cookie(embedTokenCookieName); err == nil {
					tokenStr = c.Value
				}
			}
			if tokenStr == "" {
				logger.L().Warn(ctx, "embed token missing", zap.String("host", r.Host))
				writeEmbedAuthError(w, http.StatusUnauthorized, "missing access_token")
				return
			}

			claims := jwt.MapClaims{}
			tok, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
				if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, errors.New("unexpected signing method")
				}
				return key, nil
			})
			if err != nil || !tok.Valid {
				logger.L().Warn(ctx, "embed token invalid", zap.String("host", r.Host), zap.Error(err))
				writeEmbedAuthError(w, http.StatusUnauthorized, "invalid token")
				return
			}
			if kind, _ := claims["kind"].(string); kind != embedTokenClaimKind {
				logger.L().Warn(ctx, "embed token wrong kind", zap.String("host", r.Host), zap.String("kind", kind))
				writeEmbedAuthError(w, http.StatusUnauthorized, "wrong token kind")
				return
			}
			tokSandbox, _ := claims["sandboxId"].(string)
			if tokSandbox != expectedSandboxID {
				logger.L().Warn(ctx, "embed token sandbox mismatch",
					zap.String("host", r.Host),
					zap.String("token_sandbox", tokSandbox),
					zap.String("host_sandbox", expectedSandboxID))
				writeEmbedAuthError(w, http.StatusUnauthorized, "sandbox mismatch")
				return
			}

			// Drop a session cookie so iframe asset loads after the initial
			// /vnc.html?access_token=... request stay authenticated without
			// the query param. SameSite=None+Secure is required because the
			// noVNC iframe is cross-origin to app.open-hive.com.
			fromQuery := r.URL.Query().Get(embedTokenQueryParam) != "" ||
				r.URL.Query().Get(embedTokenAltQuery) != ""
			if fromQuery {
				expFloat, _ := claims["exp"].(float64)
				maxAge := int(expFloat) - int(time.Now().Unix())
				if maxAge > 0 {
					http.SetCookie(w, &http.Cookie{
						Name:     embedTokenCookieName,
						Value:    tokenStr,
						Path:     "/",
						Secure:   true,
						HttpOnly: true,
						SameSite: http.SameSiteNoneMode,
						MaxAge:   maxAge,
					})
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

func leftmostHostLabel(host string) (string, bool) {
	// Strip port if present.
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		// IPv6 hosts are bracketed; we only proxy named hosts so this is fine.
		host = host[:i]
	}
	dot := strings.IndexByte(host, '.')
	if dot <= 0 {
		return "", false
	}
	return host[:dot], true
}

func writeEmbedAuthError(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	// Tiny page so the noVNC <webview> surfaces something readable instead
	// of a blank screen on auth failure.
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><title>Workspace unavailable</title>
<body style="font:14px system-ui;padding:2em;color:#444">
<h2>Workspace unavailable</h2>
<p>` + reason + `. Try reopening the workspace from the desktop app.</p>
</body>`))
}
