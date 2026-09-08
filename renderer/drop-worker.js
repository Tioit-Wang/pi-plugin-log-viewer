"use strict";

/*
 * Drop worker — reads dragged-in File objects via Blob.slice so file bytes
 * never need to cross the plugin bridge. Mirrors lib/log-engine.js paging
 * semantics: raw-byte line splitting, coarse block offsets, local line
 * numbering for jumps, and a sequential cursor for stats/search.
 *
 * Dropped files are snapshots: no tail follow, and identity (name+size) is
 * session-only.
 */

const CHUNK = 4 * 1024 * 1024;
const BLOCK_LINES = 512;
const MAX_PENDING = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const MAX_STORED_MATCHES = 5000;

const LEVEL_MAP = {
  FATAL: "error",
  ERROR: "error",
  WARN: "warn",
  WARNING: "warn",
  INFO: "info",
  DEBUG: "debug",
  TRACE: "debug",
};
const LEVEL_RE = /\b(FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b/;

let file = null; // { blob, name, size, encoding, readOffset, seqOffset, seqLines, seqDone, blocks, stats, pending, ring, chain }
let job = null;

function clip(t) {
  return t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS) : t;
}

function decoder() {
  return new TextDecoder(file.encoding);
}

function newlines(buf) {
  const out = [];
  let i = buf.indexOf(10);
  while (i !== -1) {
    out.push(i);
    i = buf.indexOf(10, i + 1);
  }
  return out;
}

function serialize(fn) {
  file.chain = file.chain.then(fn, fn);
  return file.chain;
}

function indexTrailingLine(buf, bufStart) {
  if (!buf || !buf.length) return;
  const line = clip(decoder().decode(buf));
  const lineNo = file.seqLines + 1;
  if (lineNo === 1 || (lineNo - 1) % BLOCK_LINES === 0) {
    file.blocks.set(Math.floor((lineNo - 1) / BLOCK_LINES), bufStart);
  }
  const m = LEVEL_RE.exec(line);
  if (m) file.stats[LEVEL_MAP[m[1]]] += 1;
  file.ring.push({ no: lineNo, text: line });
  file.seqOffset += buf.length;
  file.seqLines += 1;
}

function isUnsafeRegex(source) {
  if (!source || source.length > 200) return true;
  return (
    /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d+,?\d*\})/.test(source) ||
    /(?:\[[^\]]*\]|\\[dws])\s*[*+]\s*(?:[*+]|\{\d+,?\d*\})/i.test(source)
  );
}

async function seqStep(budget) {
  let advanced = false;
  for (let i = 0; i < budget; i += 1) {
    if (file.seqDone) break;
    const readFrom = file.readOffset;
    const slice = file.blob.slice(readFrom, readFrom + CHUNK);
    let chunk;
    try {
      chunk = new Uint8Array(await slice.arrayBuffer());
    } catch (err) {
      file.seqDone = true;
      file.error = err.message;
      break;
    }
    if (!chunk.length) {
      file.seqDone = true;
      if (file.pending && file.pending.length) {
        indexTrailingLine(file.pending, readFrom - file.pending.length);
        file.pending = null;
      }
      break;
    }
    const prevPending = file.pending ? file.pending.length : 0;
    let buf = chunk;
    if (prevPending) {
      buf = new Uint8Array(prevPending + chunk.length);
      buf.set(file.pending, 0);
      buf.set(chunk, prevPending);
    }
    const bufStart = readFrom - prevPending;
    file.readOffset = readFrom + chunk.length;
    const lastNl = buf.lastIndexOf(10);
    if (lastNl === -1) {
      if (chunk.length < CHUNK) {
        indexTrailingLine(buf, bufStart);
        file.pending = null;
        file.seqDone = true;
      } else if (buf.length > MAX_PENDING) {
        file.seqOffset += buf.length;
        file.seqLines += 1;
        file.pending = null;
      } else {
        file.pending = buf.slice();
      }
      advanced = true;
      continue;
    }
    const region = buf.subarray(0, lastNl + 1);
    const nls = newlines(buf);
    const parts = decoder().decode(region).split("\n");
    parts.pop();
    const n = Math.min(parts.length, nls.length);
    for (let k = 0; k < n; k += 1) {
      let line = parts[k];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = clip(line);
      const lineNo = file.seqLines + 1 + k;
      const absStart = bufStart + (k === 0 ? 0 : nls[k - 1] + 1);
      if (lineNo === 1 || (lineNo - 1) % BLOCK_LINES === 0) {
        file.blocks.set(Math.floor((lineNo - 1) / BLOCK_LINES), absStart);
      }
      const m = LEVEL_RE.exec(line);
      if (m) file.stats[LEVEL_MAP[m[1]]] += 1;
      file.ring.push({ no: lineNo, text: line });
    }
    file.seqOffset = bufStart + lastNl + 1;
    file.seqLines += n;
    file.pending = lastNl + 1 < buf.length ? buf.slice(lastNl + 1) : null;
    advanced = true;
    await Promise.resolve();
    if (i < budget - 1) await new Promise((r) => setTimeout(r, 0));
  }
  return advanced;
}

async function ensureIndexedTo(lineNo) {
  let guard = 0;
  while (!file.seqDone && file.seqLines < lineNo && guard < 4096) {
    const advanced = await serialize(() => seqStep(64));
    if (!advanced) break;
    guard += 1;
  }
  return file.seqDone || file.seqLines >= lineNo;
}

async function jumpScan(fromLine, count, levelSet) {
  let b = Math.floor((fromLine - 1) / BLOCK_LINES);
  if (file.blocks.get(b) === undefined) {
    await ensureIndexedTo(b * BLOCK_LINES + 1);
  }
  let blockOff = file.blocks.get(b);
  if (blockOff === undefined) return { lines: [], eof: true, partial: null, nextLine: fromLine };
  let readFrom = blockOff; // physical read cursor (past all bytes read)
  let lineNo = b * BLOCK_LINES + 1;
  let pending = null;
  let scanned = 0;
  let partial = null;
  const collect = [];
  const maxScan = 150000;
  while (collect.length < count && scanned < maxScan) {
    const chunk = new Uint8Array(await file.blob.slice(readFrom, readFrom + CHUNK).arrayBuffer());
    if (!chunk.length) {
      if (pending && pending.length) {
        const line = clip(decoder().decode(pending));
        scanned += 1;
        if (lineNo >= fromLine && wants(line, levelSet) && collect.length < count) {
          collect.push({ no: lineNo, text: line });
        }
        lineNo += 1;
        pending = null;
      }
      break;
    }
    const prevPendingLen = pending ? pending.length : 0;
    let buf = chunk;
    if (prevPendingLen) {
      buf = new Uint8Array(prevPendingLen + chunk.length);
      buf.set(pending, 0);
      buf.set(chunk, prevPendingLen);
    }
    const bufStart = readFrom - prevPendingLen;
    readFrom += chunk.length;
    const lastNl = buf.lastIndexOf(10);
    if (lastNl === -1) {
      if (chunk.length < CHUNK) {
        const line = clip(decoder().decode(buf));
        scanned += 1;
        if (lineNo >= fromLine && wants(line, levelSet) && collect.length < count) {
          collect.push({ no: lineNo, text: line });
        }
        lineNo += 1;
        pending = null;
        break;
      }
      if (buf.length > MAX_PENDING) {
        scanned += 1;
        const line = clip(decoder().decode(buf));
        if (lineNo >= fromLine && wants(line, levelSet) && collect.length < count) collect.push({ no: lineNo, text: line });
        lineNo += 1;
      } else {
        pending = buf.slice();
      }
      continue;
    }
    const nls = newlines(buf);
    const parts = decoder().decode(buf.subarray(0, lastNl + 1)).split("\n");
    parts.pop();
    const n = Math.min(parts.length, nls.length);
    for (let k = 0; k < n; k += 1) {
      let line = parts[k];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = clip(line);
      const absStart = bufStart + (k === 0 ? 0 : nls[k - 1] + 1);
      if (lineNo === 1 || (lineNo - 1) % BLOCK_LINES === 0) {
        file.blocks.set(Math.floor((lineNo - 1) / BLOCK_LINES), absStart);
      }
      scanned += 1;
      if (lineNo >= fromLine && wants(line, levelSet) && collect.length < count) collect.push({ no: lineNo, text: line });
      lineNo += 1;
    }
    const rest = buf.subarray(lastNl + 1);
    pending = rest.length > MAX_PENDING ? null : rest.length ? rest.slice() : null;
    await new Promise((r) => setTimeout(r, 0));
  }
  return { lines: collect, eof: collect.length < count && scanned < maxScan && !pending, partial, nextLine: lineNo };
}

function wants(line, levelSet) {
  if (!levelSet) return true;
  const m = LEVEL_RE.exec(line);
  return m ? levelSet.has(LEVEL_MAP[m[1]]) : levelSet.has("other");
}

async function runSearch(jobObj) {
  const { query, isRegex, caseSensitive } = jobObj;
  let re = null;
  let needle = null;
  if (isRegex) {
    if (isUnsafeRegex(query)) {
      jobObj.status = "error";
      jobObj.error = "regex rejected: too long or nested quantifiers";
      post({ type: "searchStatus", jobId: jobObj.id, status: jobObj.status, error: jobObj.error });
      return;
    }
    try {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } catch (err) {
      jobObj.status = "error";
      jobObj.error = `invalid regex: ${err.message}`;
      post({ type: "searchStatus", jobId: jobObj.id, status: jobObj.status, error: jobObj.error });
      return;
    }
  } else {
    needle = caseSensitive ? query : query.toLowerCase();
  }
  const test = (line) => (re ? re.test(line) : caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
  let offset = 0;
  let lineNo = 1;
  let pending = null;
  for (;;) {
    if (jobObj.cancelled) break;
    const chunk = new Uint8Array(await file.blob.slice(offset, offset + CHUNK).arrayBuffer());
    if (!chunk.length) {
      if (pending && pending.length) {
        const line = clip(decoder().decode(pending));
        if (test(line)) {
          jobObj.matchCount += 1;
          if (jobObj.matches.length < MAX_STORED_MATCHES) {
            jobObj.matches.push({ line: lineNo, text: line.length > 300 ? line.slice(0, 300) : line });
          }
        }
        lineNo += 1;
      }
      break;
    }
    let buf = chunk;
    if (pending) {
      buf = new Uint8Array(pending.length + chunk.length);
      buf.set(pending, 0);
      buf.set(chunk, pending.length);
    }
    const lastNl = buf.lastIndexOf(10);
    if (lastNl === -1) {
      if (chunk.length < CHUNK) {
        const line = clip(decoder().decode(buf));
        if (test(line)) {
          jobObj.matchCount += 1;
          if (jobObj.matches.length < MAX_STORED_MATCHES) {
            jobObj.matches.push({ line: lineNo, text: line.length > 300 ? line.slice(0, 300) : line });
          }
        }
        lineNo += 1;
        pending = null;
        break;
      }
      pending = buf.length > MAX_PENDING ? null : buf.slice();
      if (!pending) offset += buf.length;
      continue;
    }
    const parts = decoder().decode(buf.subarray(0, lastNl + 1)).split("\n");
    parts.pop();
    for (let k = 0; k < parts.length; k += 1) {
      let line = parts[k];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = clip(line);
      if (test(line)) {
        jobObj.matchCount += 1;
        if (jobObj.matches.length < MAX_STORED_MATCHES) {
          jobObj.matches.push({ line: lineNo, text: line.length > 300 ? line.slice(0, 300) : line });
        }
      }
      lineNo += 1;
    }
    offset += lastNl + 1;
    const rest = buf.subarray(lastNl + 1);
    pending = rest.length ? rest.slice() : null;
    jobObj.scannedBytes = offset;
    post({ type: "searchStatus", jobId: jobObj.id, status: jobObj.status, scannedBytes: jobObj.scannedBytes, matchCount: jobObj.matchCount });
    await new Promise((r) => setTimeout(r, 0));
  }
  jobObj.status = jobObj.cancelled ? "cancelled" : "done";
  post({
    type: "searchStatus",
    jobId: jobObj.id,
    status: jobObj.status,
    scannedBytes: jobObj.scannedBytes,
    matchCount: jobObj.matchCount,
    error: jobObj.error || null,
  });
}

function post(msg) {
  self.postMessage(msg);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case "open": {
        file = {
          blob: msg.file,
          name: msg.file.name,
          size: msg.file.size,
          encoding: "utf-8",
          readOffset: 0,
          seqOffset: 0,
          seqLines: 0,
          seqDone: false,
          blocks: new Map([[0, 0]]),
          stats: { error: 0, warn: 0, info: 0, debug: 0 },
          ring: { items: [], push(x) { this.items.push(x); if (this.items.length > 4000 + 1000) this.items.splice(0, this.items.length - 4000); } },
          pending: null,
          chain: Promise.resolve(),
          error: null,
        };
        post({ type: "opened", token: msg.token, name: file.name, size: file.size });
        // Background full scan for stats; posts progress via stats messages.
        (async () => {
          let last = 0;
          while (!file.seqDone) {
            const advanced = await serialize(() => seqStep(32));
            if (!advanced) break;
            if (Date.now() - last > 300) {
              last = Date.now();
              post({ type: "stats", stats: { ...file.stats }, totalLines: file.seqLines, indexDone: file.seqDone });
            }
          }
          post({ type: "stats", stats: { ...file.stats }, totalLines: file.seqLines, indexDone: file.seqDone });
        })();
        break;
      }
      case "setEncoding": {
        file.encoding = String(msg.encoding || "utf-8");
        try {
          new TextDecoder(file.encoding);
        } catch {
          file.encoding = "utf-8";
        }
        post({ type: "encoding", token: msg.token, encoding: file.encoding });
        break;
      }
      case "page": {
        let levelSet = null;
        if (Array.isArray(msg.levels) && msg.levels.length && msg.levels.length < 5) {
          levelSet = new Set(msg.levels.map(String));
        }
        const res = await jumpScan(Math.max(1, msg.fromLine | 0), Math.min(2000, Math.max(1, msg.count | 0)), levelSet);
        post({
          type: "paged",
          token: msg.token,
          lines: res.lines,
          eof: res.eof,
          partial: res.partial,
          totalLines: file.seqLines,
          indexDone: file.seqDone,
          size: file.size,
          stats: { ...file.stats },
        });
        break;
      }
      case "stats": {
        post({ type: "stats", stats: { ...file.stats }, totalLines: file.seqLines, indexDone: file.seqDone });
        break;
      }
      case "searchStart": {
        if (job && job.status === "running") job.cancelled = true;
        job = {
          id: msg.token,
          query: String(msg.query || ""),
          isRegex: Boolean(msg.isRegex),
          caseSensitive: Boolean(msg.caseSensitive),
          status: "running",
          scannedBytes: 0,
          matchCount: 0,
          matches: [],
          cancelled: false,
          error: null,
        };
        post({ type: "searchStarted", token: msg.token });
        runSearch(job);
        break;
      }
      case "searchMatches": {
        const src = job || { matches: [], matchCount: 0, status: "idle" };
        const offset = Math.max(0, msg.offset | 0);
        const limit = Math.min(500, Math.max(1, msg.limit | 0));
        post({
          type: "searchResult",
          token: msg.token,
          matches: src.matches.slice(offset, offset + limit),
          matchCount: src.matchCount,
          status: src.status,
        });
        break;
      }
      case "searchCancel": {
        if (job) job.cancelled = true;
        break;
      }
      default:
        break;
    }
  } catch (err) {
    post({ type: "workerError", token: msg.token, message: err && err.message ? err.message : String(err) });
  }
};
