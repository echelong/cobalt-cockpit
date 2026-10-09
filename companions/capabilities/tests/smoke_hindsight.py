"""Opt-in real Hindsight smoke. Does not install/start any service.

Usage: python companions/capabilities/tests/smoke_hindsight.py http://127.0.0.1:18888
Requires an independently configured server with explicitly approved local inference.
Only disposable fixture repository summaries are retained; the source document is deleted.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("hindsight", Path(__file__).parents[1] / "hindsight.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main(endpoint):
    with tempfile.TemporaryDirectory(prefix="cobalt-memory-fixture-") as directory:
        subprocess.run(["git", "init", "--quiet", directory], check=True)
        subprocess.run(["git", "-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "--quiet", "--allow-empty", "-m", "Disposable smoke fixture"], check=True)
        # Verify the synthetic recovery fact before admitting it to memory.
        lock = Path(directory) / "amber-widget.lock"
        lock.write_text("stale fixture lock")
        widget_ready = lambda: not lock.exists()
        assert not widget_ready()
        lock.unlink()
        assert widget_ready()
        client = module.Hindsight({"memory_enabled": True, "hindsight_endpoint": endpoint,
                                  "memory_retention_consent": True, "memory_inference_configured": True,
                                  "memory_timeout_ms": 120000}, directory)
        evidence = {"test_kind": "real_hindsight_local_inference", "bank_id": client.bank_id}
        doc = None
        try:
            evidence["status"] = client.execute("status")
            assert evidence["status"]["status"] == "ready", evidence["status"]
            evidence["retain"] = client.execute("retain", {
                "summary": "The disposable Cobalt fixture amber widget readiness check fails while its stale lock file exists. Removing the stale lock file lets the readiness check succeed. This recovery procedure was verified by the fixture recovery test.",
                "verified": True, "verification_reference": "disposable-fixture-recovery-test", "run_id": "hindsight-real-smoke"})
            doc = evidence["retain"].get("document_id")
            assert evidence["retain"]["status"] == "ready", evidence["retain"]
            evidence["list"] = client.execute("list")
            assert evidence["list"]["status"] == "ready" and evidence["list"]["result_count"] > 0, evidence["list"]
            evidence["recall"] = client.execute("recall", {"query": "How do we recover the amber widget service from a stale lock file?"})
            assert evidence["recall"]["status"] == "ready" and evidence["recall"]["result_count"] > 0, evidence["recall"]
            assert all(m["untrusted"] and not m["authoritative"] for m in evidence["recall"]["memories"])
            # A second repository has a distinct bank and no accidental cross-project recall.
            other = Path(directory) / "other"
            subprocess.run(["git", "init", "--quiet", str(other)], check=True)
            second = module.Hindsight(client.config, other)
            assert second.bank_id != client.bank_id
            evidence["isolated_bank"] = second.bank_id
            missing = module.Hindsight({**client.config, "hindsight_endpoint": "http://127.0.0.1:1", "memory_timeout_ms": 100}, directory)
            evidence["missing_service"] = missing.execute("status")
            assert evidence["missing_service"]["status"] == "unavailable"
            evidence["recovery"] = client.execute("status")
            assert evidence["recovery"]["status"] == "ready"
        finally:
            if doc:
                evidence["forget"] = client.execute("forget", {"document_id": doc, "confirm_document_id": doc})
                assert evidence["forget"]["status"] == "ready", evidence["forget"]
                evidence["after_forget"] = client.execute("list")
                assert evidence["after_forget"]["status"] == "ready" and evidence["after_forget"]["result_count"] == 0, evidence["after_forget"]
            print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
