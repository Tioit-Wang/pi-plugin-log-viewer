"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { LogEngine, createHostFileSystem } = require("../lib/log-engine.js");
const { detectLevel } = require("../renderer/level.js");
const { compileQuery, parseQuery } = require("../renderer/query.js");

test("level detection gives structured fields priority over message text", () => {
  assert.equal(detectLevel("2026-01-01|INFO|module|request returned ERROR text"), "info");
  assert.equal(detectLevel("2026-01-01 12:00:00 [main] ERROR module - boom"), "error");
  assert.equal(detectLevel("level:WARN request"), "warn");
  assert.equal(detectLevel("ordinary line without a level"), null);
});

test("engine streams host files through stat and bounded readRange", async () => {
  const content = Buffer.from("INFO first\nERROR second\n", "utf8");
  const calls = [];
  const fsApi = {
    stat: async (filePath, grantId) => {
      calls.push(["stat", filePath, grantId]);
      return { size: content.length, mtimeMs: 123, ino: 7, birthtimeMs: 123 };
    },
    readRange: async (filePath, byteOffset, length, grantId) => {
      calls.push(["readRange", filePath, byteOffset, length, grantId]);
      return {
        bytes: content.subarray(byteOffset, byteOffset + length),
        totalSize: content.length,
      };
    },
    list: async () => ({ path: "", entries: [] }),
  };
  const engine = new LogEngine({
    dataPath: null,
    capabilities: { hostReadRange: true, hostStat: true },
    fileSystem: createHostFileSystem(fsApi),
  });
  try {
    await engine.setRoot({ path: "" });
    const opened = await engine.openFile("logs/app.log");
    const page = await engine.page({ fileId: opened.fileId, fromLine: 1, count: 2 });
    assert.deepEqual(page.lines.map((line) => line.text), ["INFO first", "ERROR second"]);
    assert.ok(calls.some(([kind]) => kind === "stat"));
    assert.ok(calls.some(([kind, filePath]) => kind === "readRange" && filePath === "logs/app.log"));
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
  const content = Buffer.from([
    "2026-01-01|INFO|module|request returned ERROR text",
    "2026-01-01|WARN|module|retrying",
    "2026-01-01|DEBUG|module|details",
    "plain connection refused message",
    "2026-01-01|ERROR|module|database timeout",
  ].join("\n"));
  const fsApi = {
    stat: async () => ({ size: content.length, mtimeMs: 123, ino: 7, birthtimeMs: 123 }),
    readRange: async (_filePath, byteOffset, length) => ({
      bytes: content.subarray(byteOffset, byteOffset + length),
      totalSize: content.length,
    }),
    list: async () => ({ path: "", entries: [] }),
  };
  const engine = new LogEngine({
    dataPath: null,
    capabilities: { hostReadRange: true, hostStat: true },
    fileSystem: createHostFileSystem(fsApi),
  });
  try {
    await engine.setRoot({ path: "" });
    const opened = await engine.openFile("sample.log");
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
