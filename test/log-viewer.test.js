"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LogEngine } = require("../lib/log-engine.js");
const { detectLevel } = require("../renderer/level.js");
const { compileQuery, parseQuery } = require("../renderer/query.js");

test("level detection gives structured fields priority over message text", () => {
  assert.equal(detectLevel("2026-01-01|INFO|module|request returned ERROR text"), "info");
  assert.equal(detectLevel("2026-01-01 12:00:00 [main] ERROR module - boom"), "error");
  assert.equal(detectLevel("level:WARN request"), "warn");
  assert.equal(detectLevel("ordinary line without a level"), null);
});

test("query grammar supports AND, phrases, exclusions, and level filters", () => {
  const and = compileQuery({ query: "timeout database" });
  assert.equal(and.test("INFO timeout while opening database"), true);
  assert.equal(and.test("INFO timeout while opening socket"), false);

  const phrase = compileQuery({ query: '"connection refused"' });
  assert.equal(phrase.test("ERROR: connection refused"), true);
  assert.equal(phrase.test("ERROR: connection reset"), false);

  const exclude = compileQuery({ query: "timeout -healthcheck" });
  assert.equal(exclude.test("INFO timeout for api"), true);
  assert.equal(exclude.test("INFO timeout for healthcheck"), false);

  const levels = compileQuery({ query: "level:error,warn -level:debug" });
  assert.equal(levels.test("ERROR request failed"), true);
  assert.equal(levels.test("WARN retrying"), true);
  assert.equal(levels.test("DEBUG request failed"), false);
  const regex = compileQuery({ query: "^ERROR\\s+foo", isRegex: true });
  assert.equal(regex.test("ERROR    foo"), true);
  assert.deepEqual([...parseQuery('"a \\"quoted\\" phrase"').includeTerms], ['a "quoted" phrase']);
});

test("engine uses the same level filter and compiled query for native files", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "log-viewer-test-"));
  const filePath = path.join(root, "sample.log");
  await fsp.writeFile(
    filePath,
    [
      "2026-01-01|INFO|module|request returned ERROR text",
      "2026-01-01|WARN|module|retrying",
      "2026-01-01|DEBUG|module|details",
      "plain connection refused message",
      "2026-01-01|ERROR|module|database timeout",
    ].join("\n"),
  );
  const engine = new LogEngine({ dataPath: root, capabilities: {} });
  try {
    await engine.setRoot({ path: root });
    const opened = await engine.openFile(filePath);
    const filtered = await engine.page({
      fileId: opened.fileId,
      fromLine: 1,
      count: 20,
      levels: { include: ["error", "warn"], exclude: ["debug"] },
    });
    assert.deepEqual(filtered.lines.map((line) => line.no), [2, 5]);

    const { jobId } = await engine.searchStart({
      fileId: opened.fileId,
      query: "level:error database -healthcheck",
      isRegex: false,
      caseSensitive: false,
    });
    let status;
    for (let i = 0; i < 100; i += 1) {
      status = await engine.searchStatus({ jobId });
      if (status.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(status.status, "done");
    const matches = await engine.searchMatches({ jobId, offset: 0, limit: 10 });
    assert.deepEqual(matches.matches.map((match) => match.line), [5]);
  } finally {
    engine.dispose();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
