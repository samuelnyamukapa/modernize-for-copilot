#!/usr/bin/env python3
"""Run a unittest suite and report each failure as a GitHub Actions annotation.

Annotations are readable through the checks API, so a failure on a runner can be
diagnosed without downloading the job log. Usage: python convert/ci_tests.py <start-dir>
"""
import io
import os
import sys
import unittest

GAPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "windows-test-gaps.txt")


def known_gaps() -> dict:
    if os.name != "nt":
        return {}
    gaps = {}
    with open(GAPS, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#"):
                prefix, _, why = line.partition(" | ")
                gaps[prefix.strip()] = "known Windows test-fixture gap: " + why.strip()
    return gaps


def apply_skips(suite, gaps: dict) -> None:
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            apply_skips(item, gaps)
            continue
        tid = item.id()
        for prefix, why in gaps.items():
            if tid == prefix or tid.startswith(prefix + "."):
                cls = type(item)
                if tid == prefix or prefix == f"{cls.__module__}.{cls.__qualname__}":
                    if prefix == f"{cls.__module__}.{cls.__qualname__}":
                        cls.__unittest_skip__, cls.__unittest_skip_why__ = True, why
                    else:
                        setattr(item, item._testMethodName, unittest.skip(why)(getattr(item, item._testMethodName)))


def esc(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


def main() -> int:
    start = sys.argv[1]
    suite = unittest.defaultTestLoader.discover(start)
    apply_skips(suite, known_gaps())
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=1).run(suite)
    sys.stdout.write(stream.getvalue())
    problems = [("FAIL", t, tb) for t, tb in result.failures] + [("ERROR", t, tb) for t, tb in result.errors]
    for kind, test, tb in problems[:20]:
        tail = "\n".join(tb.strip().splitlines()[-12:])
        print(f"::error title={kind} {test.id()}::{esc(tail)}")
    if problems:
        print(f"::error title={start}::{len(problems)} of {result.testsRun} tests failed")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
