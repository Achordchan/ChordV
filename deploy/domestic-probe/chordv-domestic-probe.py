#!/usr/bin/env python3
"""ChordV domestic probe.

Runs on a server inside mainland China (cron, every 5 minutes). Fetches the
node list from the ChordV backend, does a few TCP handshakes to each node's
host:port (DNS resolved locally, the way a client in China would), and
reports the results back. A failed node also gets a short ping so the error
says whether ICMP is blocked too.

Configuration comes from /etc/chordv-domestic-probe.env (mode 600):
  CHORDV_API_BASE=https://v.achord.cn
  CHORDV_DOMESTIC_PROBE_TOKEN=cvdp_...
Standard library only.
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

ENV_FILE = os.environ.get("CHORDV_DOMESTIC_PROBE_ENV", "/etc/chordv-domestic-probe.env")
TCP_ATTEMPTS = 3
TCP_TIMEOUT_S = 3
# Well-known domestic sites: if none of them answers, the probe's own network is down.
CONTROL_TARGETS = [("www.baidu.com", 443), ("www.qq.com", 443), ("www.aliyun.com", 443)]


def load_env(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"')
    return values


def tcp_once(address, port):
    started = time.monotonic()
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(TCP_TIMEOUT_S)
        sock.connect((address, port))
    return max(1, int((time.monotonic() - started) * 1000))


def probe_tcp(host, port):
    try:
        address = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)[0][4][0]
    except OSError as error:
        return False, None, f"国内 DNS 解析失败：{error}", None
    latencies, last_error = [], None
    for _ in range(TCP_ATTEMPTS):
        try:
            latencies.append(tcp_once(address, port))
        except OSError as error:
            last_error = str(error) or error.__class__.__name__
    if latencies:
        return True, min(latencies), None, address
    return False, None, f"TCP {address}:{port} {TCP_ATTEMPTS} 次握手全部失败（{last_error}）", address


def ping_summary(address):
    try:
        out = subprocess.run(["ping", "-c", "3", "-W", "2", "-q", address], capture_output=True, text=True, timeout=12).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in out.splitlines():
        if "packet loss" in line:
            return "ICMP " + line.split(",")[2].strip()
    return None


def api(base, token, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base.rstrip("/") + "/api" + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "chordv-domestic-probe/1",
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode() or "null")


def main():
    env = load_env(ENV_FILE)
    base, token = env["CHORDV_API_BASE"], env["CHORDV_DOMESTIC_PROBE_TOKEN"]
    targets = api(base, token, "GET", "/domestic-probe/targets")["targets"]
    control_ok = any(probe_tcp(host, port)[0] for host, port in CONTROL_TARGETS)
    results = []
    for target in targets:
        ok, latency, error, address = probe_tcp(target["host"], int(target["port"]))
        if not ok and address:
            ping = ping_summary(address)
            if ping:
                error = f"{error}；{ping}"
        results.append({"nodeId": target["nodeId"], "tcpOk": ok, "tcpLatencyMs": latency, "error": error[:300] if error else None})
    outcome = api(base, token, "POST", "/domestic-probe/report", {"controlOk": control_ok, "results": results})
    summary = ", ".join(f"{t['name']}={'ok' if r['tcpOk'] else 'FAIL'}" for t, r in zip(targets, results))
    print(f"{time.strftime('%F %T')} control={'ok' if control_ok else 'FAIL'} {summary} -> {json.dumps(outcome, ensure_ascii=False)}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # cron mails/logs this; never retry in a loop
        print(f"{time.strftime('%F %T')} probe failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
