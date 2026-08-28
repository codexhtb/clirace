#!/usr/bin/python3
"""Minimal local identity commands for the capability-free CLIRace sandbox.

The disposable container deliberately drops every Linux capability. Standard
shadow-utils try privileged metadata operations even though the container root
already owns /etc/passwd and /etc/group. This bounded implementation supports
only the ordinary account operations used by CLIRace exercises.
"""

from pathlib import Path
import os
import re
import sys

NAME = re.compile(r"^[a-z_][a-z0-9_-]{0,30}$")
PASSWD = Path("/etc/passwd")
GROUP = Path("/etc/group")


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def valid(value: str) -> str:
    if not NAME.fullmatch(value):
        fail(f"invalid local identity name: {value}")
    return value


def records(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def append_record(path: Path, record: str) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(record + "\n")


def next_id(lines: list[str], start: int) -> int:
    used = {int(parts[2]) for line in lines if len(parts := line.split(":")) > 2 and parts[2].isdigit()}
    candidate = start
    while candidate in used:
        candidate += 1
    return candidate


def find_group(name: str) -> tuple[int, list[str]] | None:
    for index, line in enumerate(records(GROUP)):
        parts = line.split(":")
        if parts[0] == name:
            return index, parts
    return None


def groupadd(argv: list[str]) -> None:
    name = valid(argv[-1]) if argv else fail("group name is required")
    lines = records(GROUP)
    if any(line.split(":", 1)[0] == name for line in lines):
        fail(f"group already exists: {name}")
    append_record(GROUP, f"{name}:x:{next_id(lines, 2000)}:")


def useradd(argv: list[str]) -> None:
    if not argv:
        fail("user name is required")
    name = valid(argv[-1])
    primary = None
    if "-g" in argv:
        position = argv.index("-g")
        if position + 1 >= len(argv):
            fail("primary group is required")
        primary = valid(argv[position + 1])
    passwd_lines = records(PASSWD)
    if any(line.split(":", 1)[0] == name for line in passwd_lines):
        fail(f"user already exists: {name}")
    group_record = find_group(primary) if primary else find_group("root")
    if group_record is None:
        fail(f"group does not exist: {primary}")
    gid = group_record[1][2]
    append_record(PASSWD, f"{name}:x:{next_id(passwd_lines, 2000)}:{gid}::{os.devnull}:/bin/bash")


def add_member(user: str, group: str) -> None:
    user = valid(user)
    group = valid(group)
    if not any(line.split(":", 1)[0] == user for line in records(PASSWD)):
        fail(f"user does not exist: {user}")
    lines = records(GROUP)
    match = find_group(group)
    if match is None:
        fail(f"group does not exist: {group}")
    index, parts = match
    members = [item for item in parts[3].split(",") if item]
    if user not in members:
        members.append(user)
    parts[3] = ",".join(members)
    lines[index] = ":".join(parts)
    GROUP.write_text("\n".join(lines) + "\n", encoding="utf-8")


def usermod(argv: list[str]) -> None:
    if "-aG" not in argv or len(argv) < 3:
        fail("only usermod -aG GROUP USER is supported")
    position = argv.index("-aG")
    add_member(argv[-1], argv[position + 1])


def gpasswd(argv: list[str]) -> None:
    if len(argv) != 3 or argv[0] != "-a":
        fail("only gpasswd -a USER GROUP is supported")
    add_member(argv[1], argv[2])


COMMANDS = {"groupadd": groupadd, "useradd": useradd, "usermod": usermod, "gpasswd": gpasswd}
command = Path(sys.argv[0]).name
handler = COMMANDS.get(command)
if handler is None:
    fail(f"unsupported identity command: {command}")
handler([argument for argument in sys.argv[1:] if argument != "--"])
