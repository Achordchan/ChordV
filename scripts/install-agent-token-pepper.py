#!/usr/bin/env python3
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile


deploy_path = Path(os.environ["DEPLOY_PATH"])
start_script = deploy_path / "start.sh"
pepper_line = re.compile(r"^export\s+CHORDV_AGENT_TOKEN_PEPPER=(.*)$")

if not start_script.is_file():
    raise SystemExit(f"Production start script does not exist: {start_script}")

original = start_script.read_text(encoding="utf-8")
existing = None
for line in original.splitlines():
    match = pepper_line.match(line)
    if match:
        existing = match.group(1).strip().strip("'\"")
        break

if existing:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", existing):
        raise SystemExit(f"Invalid CHORDV_AGENT_TOKEN_PEPPER in {start_script}.")
    print(f"Detected existing Agent token pepper in {start_script}; preserving it.")
    raise SystemExit(0)

new_pepper = secrets.token_hex(32)
updated_lines = []
inserted = False
for line in original.splitlines():
    if pepper_line.match(line):
        if not inserted:
            updated_lines.append(f"export CHORDV_AGENT_TOKEN_PEPPER={new_pepper}")
            inserted = True
        continue
    updated_lines.append(line)
    if line.startswith("export CHORDV_JWT_SECRET=") and not inserted:
        updated_lines.append(f"export CHORDV_AGENT_TOKEN_PEPPER={new_pepper}")
        inserted = True
if not inserted:
    updated_lines.append(f"export CHORDV_AGENT_TOKEN_PEPPER={new_pepper}")
updated = "\n".join(updated_lines) + "\n"

metadata = start_script.stat()
fd, temporary_name = tempfile.mkstemp(prefix=".start.sh.", dir=start_script.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(updated)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary_name, stat.S_IMODE(metadata.st_mode))
    if hasattr(os, "chown"):
        try:
            os.chown(temporary_name, metadata.st_uid, metadata.st_gid)
        except PermissionError:
            pass
    os.replace(temporary_name, start_script)
except BaseException:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
    raise

print(f"Generated and installed Agent token pepper in {start_script}.")
