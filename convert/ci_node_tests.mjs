// Run Node test files for CI and report each failure as a GitHub annotation, because the
// Windows job logs are not readable from every place this repo is maintained. Every test gets
// a timeout and the run is forced to exit, so a handle left open fails a test instead of
// hanging the job.
//   node convert/ci_node_tests.mjs "plugin/tools/tests/canvas/*.test.mjs"
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { globSync } from "node:fs";
import path from "node:path";

const patterns = process.argv.slice(2);
const files = patterns.flatMap((p) => globSync(p)).map((f) => path.resolve(f)).sort();
if (files.length === 0) {
    console.log(`::error::no test files match ${patterns.join(" ")}`);
    process.exit(1);
}

const failures = [];
let passed = 0;
const stream = run({ files, timeout: 60_000, forceExit: true, concurrency: 1 });
stream.on("test:pass", (e) => {
    if (e.details?.type !== "suite") passed++;
});
stream.on("test:fail", (e) => {
    const err = e.details?.error;
    const cause = err?.cause ?? err;
    const msg = String(cause?.message ?? cause ?? "failed").split("\n").slice(0, 6).join(" | ");
    failures.push({ file: e.file ? path.relative(process.cwd(), e.file) : "", name: e.name, msg });
});
stream.compose(tap).pipe(process.stdout);
stream.on("end", () => {
    for (const f of failures) {
        const where = f.file ? ` file=${f.file.replace(/\\/g, "/")}` : "";
        console.log(`::error${where} title=${f.name.replace(/[\r\n:,]/g, " ")}::${f.msg.replace(/[\r\n]/g, " ")}`);
    }
    console.log(`node tests: ${passed} passed, ${failures.length} failed`);
    process.exitCode = failures.length ? 1 : 0;
});
