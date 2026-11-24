#!/usr/bin/env bash
set -euo pipefail

CONFIG=/etc/nginx/nginx.conf
CERT=/etc/letsencrypt/live/ridge-api.example.com/fullchain.pem
KEY=/etc/letsencrypt/live/ridge-api.example.com/privkey.pem
TMP_DIR="$(mktemp -d)"
UPSTREAM_PID=""
NGINX_STARTED=0

cleanup() {
  set +e
  if [[ "$NGINX_STARTED" == "1" ]]; then
    sudo nginx -s quit >/dev/null 2>&1
    sleep 1
  fi
  if [[ -n "$UPSTREAM_PID" ]]; then
    kill "$UPSTREAM_PID" >/dev/null 2>&1
    wait "$UPSTREAM_PID" >/dev/null 2>&1
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

command -v nginx >/dev/null
command -v node >/dev/null
command -v python3 >/dev/null
[[ -f "$CONFIG" && -f "$CERT" && -f "$KEY" ]]

cat > "$TMP_DIR/mock-upstream.mjs" <<'NODE'
import http from 'node:http';

const server = http.createServer((request, response) => {
  const payload = {
    path: request.url,
    method: request.method,
    host: request.headers.host ?? null,
    forwardedFor: request.headers['x-forwarded-for'] ?? null,
    forwardedProto: request.headers['x-forwarded-proto'] ?? null,
    forwardedHost: request.headers['x-forwarded-host'] ?? null,
  };
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
});

server.listen(8787, '127.0.0.1');
NODE

node "$TMP_DIR/mock-upstream.mjs" >"$TMP_DIR/upstream.log" 2>&1 &
UPSTREAM_PID=$!

for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8787/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:8787/health >/dev/null

sudo systemctl stop nginx >/dev/null 2>&1 || true
sudo nginx -t
sudo nginx -c "$CONFIG"
NGINX_STARTED=1

for attempt in $(seq 1 30); do
  if curl --insecure --silent --resolve ridge-api.example.com:443:127.0.0.1 \
    https://ridge-api.example.com/health >/dev/null; then
    break
  fi
  sleep 1
done

HTTPS_CODE="$(curl --insecure --silent --show-error \
  --resolve ridge-api.example.com:443:127.0.0.1 \
  -o "$TMP_DIR/health.json" -w '%{http_code}' \
  https://ridge-api.example.com/health)"
[[ "$HTTPS_CODE" == "200" ]]

python3 - "$TMP_DIR/health.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    payload = json.load(stream)

assert payload["path"] == "/health"
assert payload["forwardedProto"] == "https", payload
assert payload["forwardedFor"] == "127.0.0.1", payload
assert payload["forwardedHost"] == "ridge-api.example.com", payload
print("RIDGE HTTPS proxy headers: PASS")
PY

READY_CODE="$(curl --insecure --silent --resolve ridge-api.example.com:443:127.0.0.1 \
  -o /dev/null -w '%{http_code}' https://ridge-api.example.com/ready)"
[[ "$READY_CODE" == "404" ]]

HTTP_CODE="$(curl --silent --show-error --resolve ridge-api.example.com:80:127.0.0.1 \
  -o /dev/null -w '%{http_code}' http://ridge-api.example.com/health 2>/dev/null || true)"
[[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "301" && "$HTTP_CODE" != "302" && "$HTTP_CODE" != "307" && "$HTTP_CODE" != "308" ]]

BAD_HOST_CODE="$(curl --insecure --silent --resolve untrusted.example:443:127.0.0.1 \
  -o /dev/null -w '%{http_code}' https://untrusted.example/health 2>/dev/null || true)"
[[ "$BAD_HOST_CODE" != "200" ]]

CONTROL_ALLOWED_CODE="$(curl --insecure --silent --interface 127.0.0.1 \
  --resolve ridge-api.example.com:443:127.0.0.1 \
  -o /dev/null -w '%{http_code}' https://ridge-api.example.com/v1/control/probe)"
[[ "$CONTROL_ALLOWED_CODE" == "200" ]]

CONTROL_BLOCKED_CODE="$(curl --insecure --silent --interface 127.0.0.2 \
  --resolve ridge-api.example.com:443:127.0.0.1 \
  -o /dev/null -w '%{http_code}' https://ridge-api.example.com/v1/control/probe 2>/dev/null || true)"
[[ "$CONTROL_BLOCKED_CODE" == "403" ]]

python3 <<'PY'
import concurrent.futures
import ssl
import urllib.error
import urllib.request

url = "https://127.0.0.1/v1/gateway/session"
context = ssl._create_unverified_context()
total = 800

def send_one(_):
    request = urllib.request.Request(
        url,
        data=b"{}",
        headers={
            "Host": "ridge-api.example.com",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, context=context, timeout=10) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code

with concurrent.futures.ThreadPoolExecutor(max_workers=100) as executor:
    statuses = list(executor.map(send_one, range(total)))

limited = statuses.count(429)
unexpected = [status for status in statuses if status not in (200, 429)]
assert limited > 0, f"expected HTTP 429 from rate limiting; status counts={ {code: statuses.count(code) for code in set(statuses)} }"
assert not unexpected, f"unexpected status codes: {unexpected[:20]}"
print(f"RIDGE gateway rate limit: PASS ({limited}/{total} requests returned HTTP 429)")
PY

printf 'RIDGE ingress runtime checks: PASS (HTTPS=%s, ready=%s, HTTP=%s, bad-host=%s, control-allowed=%s, control-blocked=%s)\n' \
  "$HTTPS_CODE" "$READY_CODE" "$HTTP_CODE" "$BAD_HOST_CODE" "$CONTROL_ALLOWED_CODE" "$CONTROL_BLOCKED_CODE"
