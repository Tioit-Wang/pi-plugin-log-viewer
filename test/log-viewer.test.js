"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { LogEngine } = require("../lib/log-engine.js");
const { detectLevel } = require("../renderer/level.js");
const { compileQuery, parseQuery } = require("../renderer/query.js");

async function makeTempFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "log-viewer-test-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from(content, "utf8"));
  return file;
}

test("level detection gives structured fields priority over message text", () => {
  assert.equal(detectLevel("2026-01-01|INFO|module|request returned ERROR text"), "info");
  assert.equal(detectLevel("2026-01-01 12:00:00 [main] ERROR module - boom"), "error");
  assert.equal(detectLevel("level:WARN request"), "warn");
  assert.equal(detectLevel("ordinary line without a level"), null);
});

test("level detection fast path handles pipe and bracket tokens", () => {
  assert.equal(detectLevel("2026-09-08 00:00:03|INFO|handler:handle:42|url_path: /x"), "info");
  assert.equal(detectLevel("2026-09-08|ERROR|db|connection failed"), "error");
  assert.equal(detectLevel("[DEBUG] worker idle"), "debug");
  assert.equal(detectLevel("[WARNING] disk almost full"), "warn");
  // lowercase delimited token still hits the slow path and is detected
  assert.equal(detectLevel("2026-01-01|info|module|ok"), "info");
});

test("engine streams native fs files through open/stat/read", async () => {
  const file = await makeTempFile("app.log", "INFO first\nERROR second\n");
  const engine = new LogEngine({ dataPath: null });
  try {
    const opened = await engine.openFile(file);
    const page = await engine.page({ fileId: opened.fileId, fromLine: 1, count: 5 });
    assert.equal(opened.name, "app.log");
    assert.deepEqual(page.lines.map((line) => line.text), ["INFO first", "ERROR second"]);
    assert.equal(page.eof, true);
    // opening the same path again dedupes to the same engine file
    const again = await engine.openFile(file);
    assert.equal(again.fileId, opened.fileId);
  } finally {
    engine.dispose();
  }
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
  const file = await makeTempFile(
    "sample.log",
    [
      "2026-01-01|INFO|module|request returned ERROR text",
      "2026-01-01|WARN|module|retrying",
      "2026-01-01|DEBUG|module|details",
      "plain connection refused message",
      "2026-01-01|ERROR|module|database timeout",
    ].join("\n"),
  );
  const engine = new LogEngine({ dataPath: null });
  try {
    const opened = await engine.openFile(file);
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
  }
});

test("engine text filter shows only matching lines and supports invert", async () => {
  const file = await makeTempFile(
    "filter.log",
    [
      "2026-01-01|INFO|app|start ok",
      "2026-01-01|ERROR|app|database timeout",
      "2026-01-01|INFO|app|request done",
      "2026-01-01|WARN|app|slow query",
      "2026-01-01|ERROR|app|connection refused",
    ].join("\n"),
  );
  const engine = new LogEngine({ dataPath: null });
  try {
    const opened = await engine.openFile(file);
    await new Promise((r) => setTimeout(r, 20)); // let the driver index
    const onlyErrors = await engine.page({
      fileId: opened.fileId,
      fromLine: 1,
      count: 20,
      filter: { query: "ERROR", isRegex: false, caseSensitive: true },
    });
    assert.deepEqual(onlyErrors.lines.map((l) => l.text), [
      "2026-01-01|ERROR|app|database timeout",
      "2026-01-01|ERROR|app|connection refused",
    ]);

    const hideErrors = await engine.page({
      fileId: opened.fileId,
      fromLine: 1,
      count: 20,
      filter: { query: "ERROR", isRegex: false, caseSensitive: true, invert: true },
    });
    assert.deepEqual(hideErrors.lines.map((l) => l.no), [1, 3, 4]);

    const combined = await engine.page({
      fileId: opened.fileId,
      fromLine: 1,
      count: 20,
      levels: { include: ["error"], exclude: [] },
      filter: { query: "database", isRegex: false, caseSensitive: false },
    });
    assert.deepEqual(combined.lines.map((l) => l.no), [2]);
  } finally {
    engine.dispose();
  }
});

test("filtered paging keeps a true scan cursor: no missed or duplicated matches", async () => {
  const lines = [];
  for (let i = 1; i <= 500; i += 1) {
    lines.push(i % 50 === 0 ? `2026-01-01|ERROR|app|match ${i}` : `2026-01-01|INFO|app|filler ${i}`);
  }
  const file = await makeTempFile("cursor.log", lines.join("\n"));
  const engine = new LogEngine({ dataPath: null });
  try {
    const opened = await engine.openFile(file);
    let from = 1;
    let guard = 0;
    const collected = [];
    let endLines = [];
    for (; guard < 20; guard += 1) {
      const res = await engine.page({
        fileId: opened.fileId,
        fromLine: from,
        count: 4,
        filter: { query: "match", isRegex: false, caseSensitive: false },
      });
      collected.push(...res.lines);
      endLines.push(res.scanEndLine);
      from = res.scanEndLine;
      if (res.eof) break;
    }
    assert.equal(guard < 20, true, "paging terminated");
    assert.deepEqual(
      collected.map((l) => l.no),
      [50, 100, 150, 200, 250, 300, 350, 400, 450, 500],
    );
    assert.equal(endLines[0] > 4, true, "scanEndLine points past scanned fillers, not past the last match");
    for (let i = 1; i < endLines.length; i += 1) {
      assert.ok(endLines[i] > endLines[i - 1], "scan cursor strictly advances");
    }
  } finally {
    engine.dispose();
  }
});

test("poll after open does not treat existing lines as new when client is synced", async () => {
  const file = await makeTempFile("static.log", "line one\nline two\nline three\n");
  const engine = new LogEngine({ dataPath: null });
  try {
    const opened = await engine.openFile(file);
    // Sync as the renderer does after open: last seen = whatever is indexed now.
    const first = await engine.poll({ fileId: opened.fileId, sinceLine: opened.totalLines || 0 });
    // After indexing catch-up, a client that tracks totalLines should not get a gap.
    const synced = await engine.poll({ fileId: opened.fileId, sinceLine: first.totalLines });
    const append = (synced.events || []).filter((e) => e.type === "append");
    assert.equal(append.length, 0);
    assert.equal(synced.indexDone, true);
    assert.equal(synced.totalLines, 3);
  } finally {
    engine.dispose();
  }
});

test("poll detects in-place truncation rotation and reloads", async () => {
  const file = await makeTempFile("rotate.log", "old one\nold two\nold three\n");
  const engine = new LogEngine({ dataPath: null });
  try {
    const opened = await engine.openFile(file);
    await new Promise((r) => setTimeout(r, 30));
    const st = engine.statsOf({ fileId: opened.fileId });
    assert.equal(st.totalLines, 3);
    assert.equal(st.indexDone, true);
    // Rotate in place: truncate + rewrite, like a log rotator would.
    await fs.writeFile(file, Buffer.from("new alpha\nnew beta\n", "utf8"));
    const res = await engine.poll({ fileId: opened.fileId, sinceLine: 3 });
    assert.equal(res.rotated, true);
    const after = await engine.poll({ fileId: opened.fileId, sinceLine: 0 });
    assert.equal(after.totalLines, 2);
    assert.equal(after.indexDone, true);
    const page = await engine.page({ fileId: opened.fileId, fromLine: 1, count: 5 });
    assert.deepEqual(page.lines.map((l) => l.text), ["new alpha", "new beta"]);
  } finally {
    engine.dispose();
  }
});

test("listDir natively lists files with size and mtime", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "log-viewer-dir-"));
  await fs.writeFile(path.join(dir, "a.log"), "hello\n", "utf8");
  await fs.writeFile(path.join(dir, "b.txt"), "world\n", "utf8");
  await fs.mkdir(path.join(dir, "sub"));
  const engine = new LogEngine({ dataPath: null });
  try {
    const listed = await engine.listDir(dir);
    assert.equal(listed.path, dir);
    const names = listed.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["a.log", "b.txt"]);
    for (const ent of listed.entries) {
      assert.equal(ent.isDirectory, false);
      assert.equal(typeof ent.size, "number");
      assert.equal(typeof ent.mtimeMs, "number");
      assert.equal(path.isAbsolute(ent.path), true);
    }
    // empty / missing paths fail with a clear error
    await assert.rejects(() => engine.listDir(""), /directory path required/);
    await assert.rejects(() => engine.listDir(path.join(dir, "nope")), /cannot list directory/);
  } finally {
    engine.dispose();
  }
});
