#!/usr/bin/env python3
"""Run a unittest suite and report each failure as a GitHub Actions annotation.

Annotations are readable through the checks API, so a failure on a runner can be
diagnosed without downloading the job log. Usage: python convert/ci_tests.py <start-dir>
"""
import io
import sys
import unittest


def esc(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


def main() -> int:
    start = sys.argv[1]
    suite = unittest.defaultTestLoader.discover(start)
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
