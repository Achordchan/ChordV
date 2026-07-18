#!/usr/bin/env python3
import base64
import binascii
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile


deploy_path = Path(os.environ["DEPLOY_PATH"])
key_line = re.compile(
    r"^(?:export\s+)?(?:CHORDV_PANEL_PASSWORD_MASTER_KEY|CHORDV_SECRET_ENCRYPTION_KEY)=(.*)$"
)


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def is_valid_key(value: str) -> bool:
    if re.fullmatch(r"[0-9a-fA-F]{64}", value):
        return True
    try:
        return len(base64.b64decode(value, validate=True)) == 32
    except (binascii.Error, ValueError):
        return False


candidates = [
    deploy_path / ".env",
    deploy_path / ".env.local",
    deploy_path / "apps/api/.env",
    deploy_path / "apps/api/.env.local",
]
target = next((path for path in candidates if path.is_file()), None)
if target is None:
    raise SystemExit(
        f"No production env file exists under {deploy_path}; refusing to create an incomplete env file."
    )

for env_file in candidates:
    if not env_file.is_file():
        continue
    for line in env_file.read_text(encoding="utf-8").splitlines():
        match = key_line.match(line)
        if not match:
            continue
        existing_key = unquote(match.group(1))
        if not existing_key:
            continue
        if not is_valid_key(existing_key):
            raise SystemExit(f"Invalid panel password master key in {env_file}.")
        print(f"Detected existing panel password master key in {env_file}; preserving it.")
        raise SystemExit(0)

new_key = secrets.token_hex(32)
original = target.read_text(encoding="utf-8")
updated_lines = []
inserted = False
for line in original.splitlines():
    if key_line.match(line):
        if not inserted:
            updated_lines.append(f"CHORDV_PANEL_PASSWORD_MASTER_KEY={new_key}")
            inserted = True
        continue
    updated_lines.append(line)
if not inserted:
    updated_lines.append(f"CHORDV_PANEL_PASSWORD_MASTER_KEY={new_key}")
updated = "\n".join(updated_lines) + "\n"

metadata = target.stat()
fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
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
    os.replace(temporary_name, target)
except BaseException:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
    raise

print(f"Generated and installed panel password master key in {target}.")
