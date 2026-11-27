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
import concurrent.futures
import fcntl
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
MAX_ADDRESSES = 4
WORKERS = 8
# A round must finish well inside the 5-minute cron interval. Targets still
# running at the deadline are left out of the report (their status is not
# touched) instead of being reported late as if they were fresh.
ROUND_DEADLINE_S = 200
LOCK_FILE = "/run/chordv-domestic-probe.lock"
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


def resolve(host, port):
    """All distinct addresses for host, in resolver order (at most MAX_ADDRESSES)."""
    addresses = []
    for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        address = info[4][0]
        if address not in addresses:
            addresses.append(address)
    return addresses[:MAX_ADDRESSES]


def probe_tcp(host, port):
    """Reachable when any resolved address accepts a handshake on any of TCP_ATTEMPTS tries."""
    try:
        addresses = resolve(host, port)
    except OSError as error:
        return False, None, f"国内 DNS 解析失败：{error}", None
    if not addresses:
        return False, None, "国内 DNS 没有返回地址", None
    last_error = None
    for _ in range(TCP_ATTEMPTS):
        for address in addresses:
            try:
                return True, tcp_once(address, port), None, address
            except OSError as error:
                last_error = str(error) or error.__class__.__name__
    shown = ",".join(addresses)
    return False, None, f"TCP {shown}:{port} {TCP_ATTEMPTS} 轮握手全部失败（{last_error}）", addresses[0]


def probe_target(target):
    ok, latency, error, address = probe_tcp(target["host"], int(target["port"]))
    if not ok and address:
        ping = ping_summary(address)
        if ping:
            error = f"{error}；{ping}"
    return {"nodeId": target["nodeId"], "tcpOk": ok, "tcpLatencyMs": latency, "error": error[:100] if error else None}


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
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    request = urllib.request.Request(base.rstrip("/") + "/api" + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "chordv-domestic-probe/1",
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode() or "null")


def main():
    # cron must never run two rounds at once: overlapping rounds could report out of order.
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"{time.strftime('%F %T')} previous round still running, skipped", flush=True)
        return

    env = load_env(ENV_FILE)
    base, token = env["CHORDV_API_BASE"], env["CHORDV_DOMESTIC_PROBE_TOKEN"]
    targets = api(base, token, "GET", "/domestic-probe/targets")["targets"]
    started = time.monotonic()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS)
    control = pool.submit(lambda: any(probe_tcp(host, port)[0] for host, port in CONTROL_TARGETS))
    # The API hands out the least recently scheduled nodes first and rotates
    # the list itself, so nodes cut off by the deadline come first next round.
    futures = {pool.submit(probe_target, target): target for target in targets}
    done, pending = concurrent.futures.wait([control, *futures], timeout=ROUND_DEADLINE_S)
    pool.shutdown(wait=False, cancel_futures=True)
    if control not in done:
        print(f"{time.strftime('%F %T')} control check timed out, round dropped", flush=True)
        os._exit(1)
    results = [future.result() for future in futures if future in done]
    names = {target["nodeId"]: target["name"] for target in targets}
    outcome = api(base, token, "POST", "/domestic-probe/report", {"controlOk": control.result(), "results": results})
    summary = ", ".join(f"{names[r['nodeId']]}={'ok' if r['tcpOk'] else 'FAIL'}" for r in results)
    late = f" timedOut={len(pending)}" if pending else ""
    print(f"{time.strftime('%F %T')} control={'ok' if control.result() else 'FAIL'} {summary}{late} "
          f"({time.monotonic() - started:.1f}s) -> {json.dumps(outcome, ensure_ascii=False)}", flush=True)
    # Worker threads stuck past the deadline must not keep the process (and the lock) alive.
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # cron mails/logs this; never retry in a loop
        print(f"{time.strftime('%F %T')} probe failed: {error}", file=sys.stderr, flush=True)
        # os._exit, not sys.exit: a normal interpreter shutdown waits for stuck
        # worker threads, which would keep the process and its lock alive.
        os._exit(1)
