"""Optional, bounded Hindsight REST client. No service startup or transcript access."""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, quote
import uuid


MAX_RESPONSE = 262144
CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
SECRET = re.compile(
    r"-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\b(?:sk-[A-Za-z0-9_-]{12,}|"
    r"sk_(?:live|test)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{12,}|"
    r"gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b|"
    r"\b(?:Bearer|Basic)\s+\S+|"
    r"(?:password|passwd|api[_ -]?key|access[_ -]?token|token|secret|authorization|cookie)"
    r"[\"']?\s*[:=]\s*[\"']?\S+|https?://[^\s/@]+:[^\s/@]+@", re.I)


def contains_secret(value):
    """Reject obvious secrets throughout caller data; not a complete DLP detector."""
    if isinstance(value, dict):
        return any(contains_secret(k) or contains_secret(v) for k, v in value.items())
    if isinstance(value, (tuple, list)):
        return any(contains_secret(v) for v in value)
    return isinstance(value, str) and bool(SECRET.search(value))


def _git(repo, *args):
    try:
        out = subprocess.run(["git", "-C", str(repo), *args], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=2, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if len(out.stdout) > 8192:
            return ""
        return out.stdout.decode("utf-8", errors="strict").strip()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return ""


def repository_identity(repo):
    """Hash normalized remote (without userinfo), otherwise canonical Git common-dir."""
    repo = Path(repo).resolve()
    common = _git(repo, "rev-parse", "--git-common-dir")
    if not common:
        raise ValueError("repository_required")
    origin = _git(repo, "config", "--get", "remote.origin.url")
    identity = None
    if origin and not any(c.isspace() for c in origin):
        try:
            if "://" in origin:
                u = urlsplit(origin)
                if u.scheme in ("https", "http", "ssh", "git") and u.hostname and not u.query and not u.fragment:
                    host = u.hostname.lower()
                    # Transport/userinfo don't define repository identity; custom ports do.
                    port = u.port
                    default = {"https": 443, "http": 80, "ssh": 22, "git": 9418}[u.scheme]
                    host += f":{port}" if port and port != default else ""
                    path = u.path.strip("/")
                    identity = f"remote:{host}/{path.removesuffix('.git')}" if path else None
            else:
                m = re.fullmatch(r"(?:[^/@:]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_./-]+)", origin)
                if m:
                    identity = f"remote:{m[1].lower()}/{m[2].strip('/').removesuffix('.git')}"
        except ValueError:
            pass
    if not identity:
        identity = "local:" + str((repo / common).resolve())
    return "cobalt-" + hashlib.sha256(identity.encode()).hexdigest()


def _worktree_dirty(repo):
    try:
        out = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2,
                             env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        return "true" if out.stdout else "false"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


class Hindsight:
    def __init__(self, config, repo):
        self.config = dict(config)
        self.repo = Path(repo)
        self._bank_id = None

    @property
    def bank_id(self):
        if self.config.get("memory_enabled") is not True:
            return None
        if self._bank_id is None:
            self._bank_id = repository_identity(self.repo)
        return self._bank_id

    def _request(self, method, path, body=None):
        # HTTPConnection ignores HTTP(S)_PROXY; redirects are never followed.
        u = urlsplit(self.config.get("hindsight_endpoint", ""))
        if u.scheme != "http" or u.username or u.password or u.query or u.fragment or u.path not in ("", "/"):
            raise ValueError("invalid_endpoint")
        try:
            if not ipaddress.ip_address(u.hostname).is_loopback:
                raise ValueError("invalid_endpoint")
            port = u.port or 8888
        except (TypeError, ValueError):
            raise ValueError("invalid_endpoint") from None
        timeout_ms = self.config.get("memory_timeout_ms", 10000)
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 120000:
            raise ValueError("invalid_timeout")
        deadline = time.monotonic() + timeout_ms / 1000
        connection = http.client.HTTPConnection(u.hostname, port, timeout=timeout_ms / 1000)
        timer = None
        try:
            encoded = json.dumps(body, ensure_ascii=True).encode() if body is not None else None
            connection.connect()
            transport_socket = connection.sock

            def close_at_deadline():
                try:
                    transport_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            # One bounded deadline timer, canceled on completion. Also bounds slow headers.
            timer = threading.Timer(max(0, deadline - time.monotonic()), close_at_deadline)
            timer.daemon = True
            timer.start()
            connection.request(method, path, body=encoded, headers={"Content-Type": "application/json", "Accept": "application/json"})
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                raise ValueError("service_error")
            length = response.getheader("Content-Length")
            if length is not None and (not length.isdigit() or int(length) > MAX_RESPONSE):
                raise ValueError("response_too_large")
            data = bytearray()
            # read1 plus changing socket deadline bounds a slow streaming service.
            while True:
                if response.fp is None:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                response.fp.raw._sock.settimeout(remaining)
                chunk = response.read1(min(8192, MAX_RESPONSE + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_RESPONSE:
                    raise ValueError("response_too_large")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("invalid_response")
            return result
        except (OSError, http.client.HTTPException, ValueError):
            if time.monotonic() >= deadline:
                raise TimeoutError() from None
            raise
        finally:
            if timer is not None:
                timer.cancel()
            connection.close()

    def _memories(self, rows):
        if not isinstance(rows, list):
            raise ValueError("invalid_response")
        now = datetime.now(timezone.utc)
        commit = _git(self.repo, "rev-parse", "HEAD")
        results = []
        for row in rows[:20]:
            if not isinstance(row, dict):
                raise ValueError("invalid_response")
            text = row.get("text", row.get("content", ""))
            if not isinstance(text, str):
                raise ValueError("invalid_response")
            metadata = row.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            owned = metadata.get("repository_id") == self.bank_id
            stamp = metadata.get("timestamp")
            age = None
            try:
                delta = (now - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds()
                age = int(delta / 86400) if delta >= 0 else None
            except (TypeError, ValueError, AttributeError):
                pass
            # Service results are never trusted as authority, even with matching metadata.
            provenance = {k: CONTROLS.sub("", metadata[k][:512]) for k in ("source_commit", "source_dirty", "run_id", "timestamp", "verification_reference", "source_references")
                          if isinstance(metadata.get(k), str) and not contains_secret(metadata[k])}
            identifier = row.get("id", "")
            document = row.get("document_id", "")
            identifier = identifier if isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) else ""
            document = document if isinstance(document, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", document) else ""
            scores = row.get("scores")
            scores = {k: v for k, v in scores.items() if k in ("semantic", "keyword", "reranker", "final")
                      and isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                      and abs(v) <= 1e12} if isinstance(scores, dict) else None
            results.append({"id": "" if contains_secret(identifier) else identifier,
                            "document_id": "" if contains_secret(document) else document,
                            "text": "[excluded: possible secret]" if contains_secret(text) else CONTROLS.sub("", text[:4000]),
                            "untrusted": True, "authoritative": False, "requires_verification": True,
                            "verification_status": "source_reported_verified" if owned and metadata.get("verification_status") == "verified" else "unverified",
                            "freshness": "stale" if age is not None and age > 30 else "unknown" if age is None else "recent_reference",
                            "age_days": age, "commit_matches": bool(commit and metadata.get("source_commit") == commit),
                            "confidence": "not_assessed", "relevance_scores": scores,
                            "provenance": provenance})
        return results

    def execute(self, operation, arguments=None):
        started = time.monotonic()
        valid_operation = isinstance(operation, str) and operation in ("status", "recall", "retain", "reflect", "list", "forget")
        result = {"capability": "memory", "operation": operation if valid_operation else "invalid", "status": "disabled"}
        if self.config.get("memory_enabled") is not True:
            result["duration_ms"] = 0
            return result
        try:
            if not valid_operation:
                raise ValueError("unsupported_operation")
            args = arguments if arguments is not None else {}
            if not isinstance(args, dict) or contains_secret(args):
                raise ValueError("secret_or_invalid_input")
            result["bank_id"] = self.bank_id
            prefix = "/v1/default/banks/" + quote(self.bank_id, safe="")
            document_prefix = "cobalt-" + self.bank_id[7:23] + "-"
            if operation == "status":
                data = self._request("GET", "/health")
                if data.get("status") != "healthy" or data.get("database") != "connected":
                    raise ValueError("invalid_response")
                result["status"] = "ready"
            elif operation in ("recall", "reflect"):
                if self.config.get("memory_inference_configured") is not True:
                    raise ValueError("inference_not_configured")
                query = args.get("query")
                if not isinstance(query, str) or not query.strip() or len(query) > 2000:
                    raise ValueError("invalid_query")
                body = {"query": query, "budget": "low", "max_tokens": 1024}
                if operation == "recall":
                    body.update({"trace": False, "include": {"entities": None, "chunks": None, "source_facts": None}})
                    data = self._request("POST", prefix + "/memories/recall", body)
                    result["memories"] = self._memories(data.get("results"))
                    result["result_count"] = len(result["memories"])
                else:
                    data = self._request("POST", prefix + "/reflect", body)
                    text = data.get("text")
                    if not isinstance(text, str):
                        raise ValueError("invalid_response")
                    result["reflection"] = {"text": "[excluded: possible secret]" if contains_secret(text) else CONTROLS.sub("", text[:4000]),
                                            "untrusted": True, "authoritative": False, "requires_verification": True}
                    result["result_count"] = 1
                result["status"] = "ready"
            elif operation == "list":
                data = self._request("GET", prefix + "/memories/list?limit=20&offset=0")
                result["memories"] = self._memories(data.get("items"))
                result["result_count"] = len(result["memories"])
                result["status"] = "ready"
            elif operation == "retain":
                if self.config.get("memory_retention_consent") is not True:
                    raise ValueError("retention_consent_required")
                if self.config.get("memory_inference_configured") is not True:
                    raise ValueError("inference_not_configured")
                if set(args) - {"summary", "verified", "verification_reference", "run_id", "source_references"}:
                    raise ValueError("summary_only")
                summary = args.get("summary")
                if args.get("verified") is not True:
                    raise ValueError("verification_required")
                if not isinstance(summary, str) or not summary.strip() or len(summary) > 4000:
                    raise ValueError("invalid_summary")
                if any(not isinstance(args.get(k), str) or not args[k].strip() or len(args[k]) > 512
                       for k in ("verification_reference", "run_id")):
                    raise ValueError("provenance_required")
                references = args.get("source_references", "")
                if isinstance(references, list):
                    if len(references) > 10 or any(not isinstance(ref, str) or len(ref) > 512 for ref in references):
                        raise ValueError("invalid_references")
                    references = json.dumps(references, ensure_ascii=True)
                if not isinstance(references, str) or len(references) > 1000:
                    raise ValueError("invalid_references")
                commit = _git(self.repo, "rev-parse", "HEAD")
                if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
                    raise ValueError("source_commit_required")
                stamp = datetime.now(timezone.utc).isoformat()
                document_id = document_prefix + uuid.uuid4().hex
                # Expose the scoped ID even if acknowledgment is lost, enabling reconciliation.
                result["document_id"] = document_id
                body = {"async": False, "items": [{"content": summary, "timestamp": stamp,
                        "context": "verified_cockpit_finding", "document_id": document_id,
                        "metadata": {"repository_id": self.bank_id, "source_commit": commit,
                                     "source_dirty": _worktree_dirty(self.repo), "run_id": args["run_id"],
                                     "timestamp": stamp, "verification_status": "verified",
                                     "verification_reference": args["verification_reference"], "source_references": references},
                        "tags": ["cockpit_verified"], "update_mode": "replace"}]}
                data = self._request("POST", prefix + "/memories", body)
                if data.get("success") is not True or data.get("bank_id") != self.bank_id or data.get("async") is not False or data.get("items_count") != 1:
                    raise ValueError("invalid_response")
                result.update(status="ready", result_count=1, document_id=document_id)
            elif operation == "forget":
                document_id = args.get("document_id")
                if not isinstance(document_id, str) or not re.fullmatch(re.escape(document_prefix) + r"[0-9a-f]{32}", document_id):
                    raise ValueError("document_scope_refused")
                if args.get("confirm_document_id") != document_id:
                    raise ValueError("deletion_confirmation_required")
                data = self._request("DELETE", prefix + "/documents/" + quote(document_id, safe=""))
                if data.get("success") is not True or data.get("document_id") != document_id:
                    raise ValueError("invalid_response")
                result.update(status="ready", result_count=1, document_id=document_id)
            else:
                raise ValueError("unsupported_operation")
        except (TimeoutError, socket.timeout):
            result.update(status="unavailable", error="timeout", fallback=True)
        except (ConnectionError, OSError, http.client.HTTPException):
            result.update(status="unavailable", error="service_unavailable", fallback=True)
        except (ValueError, TypeError, AttributeError, RecursionError, OverflowError):
            # Never surface raw server bodies, URLs, credentials or exception strings.
            result.update(status="error", error="operation_refused_or_invalid_response", fallback=True)
        if operation == "retain" and "document_id" in result:
            result["outcome"] = "confirmed" if result["status"] == "ready" else "unknown"
        result["duration_ms"] = int((time.monotonic() - started) * 1000)
        return result
