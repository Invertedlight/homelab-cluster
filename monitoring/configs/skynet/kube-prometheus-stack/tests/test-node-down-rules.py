#!/usr/bin/env python3
"""Run promtool unit tests for the NodeDown PrometheusRule.

Extracts spec from node-down-alerts.yaml so the CR and the rules under test
cannot drift. promtool is PROMTOOL, else promtool on PATH, else the 2.55.1
tarball unpacked at /tmp/prometheus-2.55.1.linux-amd64/promtool.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULE_CR = HERE.parent / "node-down-alerts.yaml"
TEST_SRC = HERE / "node-down-rules.test.yml"


def promtool_bin() -> str:
    env = os.environ.get("PROMTOOL")
    if env:
        return env
    found = shutil.which("promtool")
    if found:
        return found
    bundled = Path("/tmp/prometheus-2.55.1.linux-amd64/promtool")
    if bundled.is_file():
        return str(bundled)
    sys.exit("promtool not found; set PROMTOOL or install Prometheus 2.55.1")


def rules_yaml() -> str:
    text = RULE_CR.read_text()
    marker = "\nspec:\n"
    if marker not in text:
        sys.exit(f"{RULE_CR} has no spec block")
    spec = text.split(marker, 1)[1]
    lines = []
    for line in spec.splitlines():
        if line.startswith("  "):
            lines.append(line[2:])
        elif line.strip() == "":
            lines.append("")
        else:
            sys.exit(f"unexpected spec indent: {line!r}")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    tool = promtool_bin()
    rules = rules_yaml()
    with tempfile.TemporaryDirectory(prefix="node-down-rules-") as tmp:
        root = Path(tmp)
        (root / "node-down.rules.yml").write_text(rules)
        (root / "node-down-rules.test.yml").write_text(TEST_SRC.read_text())
        check = subprocess.run(
            [tool, "check", "rules", str(root / "node-down.rules.yml")],
            cwd=root,
        )
        if check.returncode != 0:
            return check.returncode
        test = subprocess.run(
            [tool, "test", "rules", str(root / "node-down-rules.test.yml")],
            cwd=root,
        )
        return test.returncode


if __name__ == "__main__":
    sys.exit(main())
