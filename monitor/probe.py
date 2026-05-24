from __future__ import annotations

from dataclasses import dataclass
import json
import random
import socket
import string
import time
from typing import Any


COMMAND_PREFIX = "!"
JM_APP_NAME = "joinmarket"
JM_VERSION = 5
NOT_SERVING_ONION = "NOT-SERVING-ONION"
MSG_HANDSHAKE = 793
MSG_DN_HANDSHAKE = 795
MSG_PRIVMSG = 685
MSG_PUBMSG = 687
OFFER_TYPES = {
    "reloffer",
    "absoffer",
    "swreloffer",
    "swabsoffer",
    "sw0reloffer",
    "sw0absoffer",
}
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


@dataclass(frozen=True)
class DirectoryNode:
    host: str
    port: int = 5222

    @classmethod
    def parse(cls, value: str) -> "DirectoryNode":
        host, sep, port = value.rpartition(":")
        if not sep:
            return cls(value, 5222)
        return cls(host, int(port))

    def location(self) -> str:
        return f"{self.host}:{self.port}"


def make_nick() -> str:
    suffix = "".join(random.choice(BASE58_ALPHABET) for _ in range(14))
    return f"J{JM_VERSION}{suffix}"


def encode_message(msg_type: int, line: str) -> bytes:
    return json.dumps({"type": msg_type, "line": line}, separators=(",", ":")).encode(
        "utf-8"
    ) + b"\r\n"


def decode_line(line: bytes) -> dict[str, Any]:
    return json.loads(line.decode("utf-8").strip())


def read_line(sock: socket.socket, buffer: bytearray, timeout: float) -> bytes:
    deadline = time.time() + timeout
    while True:
        newline_index = buffer.find(b"\n")
        if newline_index >= 0:
            line = bytes(buffer[: newline_index + 1])
            del buffer[: newline_index + 1]
            return line

        remaining = deadline - time.time()
        if remaining <= 0:
            raise socket.timeout()
        sock.settimeout(min(remaining, 1.0))
        chunk = sock.recv(4096)
        if not chunk:
            return b""
        buffer.extend(chunk)


def recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise RuntimeError("SOCKS5 connection closed early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def socks5_connect(
    socks_host: str,
    socks_port: int,
    target_host: str,
    target_port: int,
    timeout: int,
) -> socket.socket:
    sock = socket.create_connection((socks_host, socks_port), timeout=timeout)
    sock.settimeout(timeout)
    sock.sendall(b"\x05\x01\x00")
    greeting = recv_exact(sock, 2)
    if greeting != b"\x05\x00":
        sock.close()
        raise RuntimeError(f"SOCKS5 greeting failed: {greeting!r}")

    host_bytes = target_host.encode("idna")
    if len(host_bytes) > 255:
        sock.close()
        raise RuntimeError("SOCKS5 target host is too long")
    request = (
        b"\x05\x01\x00\x03"
        + bytes([len(host_bytes)])
        + host_bytes
        + target_port.to_bytes(2, "big")
    )
    sock.sendall(request)
    response = recv_exact(sock, 4)
    if response[1] != 0:
        sock.close()
        raise RuntimeError(f"SOCKS5 connect failed: {response[1]}")
    atyp = response[3]
    if atyp == 1:
        recv_exact(sock, 4)
    elif atyp == 3:
        length = recv_exact(sock, 1)[0]
        recv_exact(sock, length)
    elif atyp == 4:
        recv_exact(sock, 16)
    else:
        sock.close()
        raise RuntimeError(f"SOCKS5 response has invalid address type: {atyp}")
    recv_exact(sock, 2)
    return sock


def parse_joinmarket_payload(text: str, own_nick: str) -> tuple[list[dict[str, Any]], int]:
    parts = text.split(COMMAND_PREFIX)
    if len(parts) < 3:
        return [], 0
    from_nick, to_nick = parts[0], parts[1]
    if to_nick not in {own_nick, "PUBLIC"}:
        return [], 0

    offers: list[dict[str, Any]] = []
    fidelity_bonds = 0
    for command in parts[2:]:
        chunks = command.split()
        if not chunks:
            continue
        name = chunks[0]
        if name in OFFER_TYPES and len(chunks) >= 6:
            offers.append(
                {
                    "counterparty": from_nick,
                    "ordertype": name,
                    "oid": chunks[1],
                    "minsize": chunks[2],
                    "maxsize": chunks[3],
                    "txfee": chunks[4],
                    "cjfee": chunks[5],
                }
            )
        elif name == "tbond" and len(chunks) >= 2:
            fidelity_bonds += 1
    return offers, fidelity_bonds


def probe_directory_node(
    node_value: str,
    socks_host: str,
    socks_port: int,
    network: str,
    timeout: int,
    collect_seconds: int,
) -> dict[str, Any]:
    node = DirectoryNode.parse(node_value)
    nick = make_nick()
    started = time.time()
    result: dict[str, Any] = {
        "node": node.location(),
        "ok": False,
        "latency_ms": None,
        "offers": 0,
        "orderbook_offers": [],
        "fidelity_bonds": 0,
        "makers": 0,
        "messages": 0,
        "error": None,
    }

    offers_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    makers: set[str] = set()
    fidelity_bonds = 0

    sock: socket.socket | None = None
    try:
        sock = socks5_connect(socks_host, socks_port, node.host, node.port, timeout)
        read_buffer = bytearray()
        handshake = {
            "app-name": JM_APP_NAME,
            "directory": False,
            "location-string": NOT_SERVING_ONION,
            "proto-ver": JM_VERSION,
            "features": {},
            "nick": nick,
            "network": network,
        }
        sock.sendall(encode_message(MSG_HANDSHAKE, json.dumps(handshake)))
        deadline = time.time() + timeout
        accepted = False
        while time.time() < deadline:
            raw = read_line(sock, read_buffer, deadline - time.time())
            if not raw:
                raise RuntimeError("connection closed before handshake")
            message = decode_line(raw)
            if message.get("type") != MSG_DN_HANDSHAKE:
                continue
            server_handshake = json.loads(message["line"])
            if not server_handshake.get("accepted"):
                raise RuntimeError("directory rejected handshake")
            if server_handshake.get("network") != network:
                raise RuntimeError(
                    f"network mismatch: {server_handshake.get('network')}"
                )
            accepted = True
            result["latency_ms"] = round((time.time() - started) * 1000)
            break
        if not accepted:
            raise RuntimeError("directory handshake timed out")

        sock.sendall(encode_message(MSG_PUBMSG, f"{nick}!PUBLIC!orderbook"))
        collect_deadline = time.time() + collect_seconds
        while time.time() < collect_deadline:
            try:
                raw = read_line(sock, read_buffer, 1)
            except socket.timeout:
                continue
            if not raw:
                break
            message = decode_line(raw)
            result["messages"] += 1
            if message.get("type") not in {MSG_PRIVMSG, MSG_PUBMSG}:
                continue
            parsed_offers, parsed_bonds = parse_joinmarket_payload(
                str(message.get("line", "")),
                nick,
            )
            fidelity_bonds += parsed_bonds
            for offer in parsed_offers:
                makers.add(offer["counterparty"])
                key = (offer["counterparty"], offer["oid"], offer["ordertype"])
                offers_by_key[key] = offer

        result.update(
            ok=True,
            offers=len(offers_by_key),
            orderbook_offers=[offers_by_key[key] for key in sorted(offers_by_key)],
            fidelity_bonds=fidelity_bonds,
            makers=len(makers),
        )
    except Exception as exc:
        result["error"] = str(exc)
    finally:
        if sock is not None:
            sock.close()
    return result
