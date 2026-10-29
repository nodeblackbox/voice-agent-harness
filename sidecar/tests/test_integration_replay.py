"""End to end with the real models: start the sidecar, replay recordings, expect finals and a barge-in cut.

Skipped unless EAR_INTEGRATION=1 (needs the GPU stack) with EAR_WAV and EAR_BARGE_WAV pointing at 16 kHz mono
recordings: one utterance, and one to inject while the agent speaks.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parent.parent
WAV = Path(os.environ["EAR_WAV"]) if os.environ.get("EAR_WAV") else None
BARGE = Path(os.environ["EAR_BARGE_WAV"]) if os.environ.get("EAR_BARGE_WAV") else None

pytestmark = pytest.mark.integration


@pytest.mark.skipif(os.environ.get("EAR_INTEGRATION") != "1", reason="set EAR_INTEGRATION=1 to run against real models")
def test_replay_with_barge_in():
    if WAV is None or BARGE is None or not WAV.exists() or not BARGE.exists():
        pytest.skip("set EAR_WAV and EAR_BARGE_WAV to existing recordings")
    proc = subprocess.Popen([sys.executable, "-m", "ear", "--port", "0"], cwd=SIDECAR, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    try:
        line = proc.stdout.readline() if proc.stdout else ""
        m = re.match(r"EAR_PORT (\d+)", line)
        assert m, f"no EAR_PORT line, got {line!r}"
        result = subprocess.run(
            [sys.executable, str(SIDECAR / "tests" / "replay_client.py"), "--port", m.group(1), str(WAV), "--bargein", str(BARGE), "--fast"],
            cwd=SIDECAR, capture_output=True, text=True, timeout=300)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "bargein stages:" in result.stdout and "cut" in result.stdout
    finally:
        proc.kill()
        proc.wait(timeout=10)
        time.sleep(0.2)
