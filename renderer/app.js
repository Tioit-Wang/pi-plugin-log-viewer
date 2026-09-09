"use strict";

/* Large log viewer — panel UI. All file reads go through the host fs gateway. */

const bridge = window.pluginBridge;
const $ = (id) => document.getElementById(id);

const OVERSCAN = 10;
const state = {
  tabs: [],
  activeId: null,
  nextTabId: 1,
  fontSize: Number(localStorage.getItem("lv.fontSize")) || 12,
  fontFamily: localStorage.getItem("lv.fontFamily") || "default",
  theme: localStorage.getItem("lv.theme") || null, // null → follow host
};
let rowH = 20;

const scroller = $("scroller");
const spacer = $("spacer");

// ---------- small utils ------------------------------------------------------

function fmtSize(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms) {
  if (!Number.isFinite(ms) || !ms) return "";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function invoke(channel, payload) {
  return bridge.invoke(channel, payload);
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function hasLevelFilter(tab) {
  return Boolean(tab && ((tab.levels && tab.levels.size) || (tab.excludedLevels && tab.excludedLevels.size)));
}

function levelFilterPayload(tab) {
  if (!hasLevelFilter(tab)) return null;
  return {
    include: tab.levels ? [...tab.levels] : [],
    exclude: tab.excludedLevels ? [...tab.excludedLevels] : [],
  };
}

function badgeState(tab, level) {
  if (tab && tab.levels && tab.levels.has(level)) return "include";
  if (tab && tab.excludedLevels && tab.excludedLevels.has(level)) return "exclude";
  return "neutral";
}

function atBottom() {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
}

// ---------- adapters ---------------------------------------------------------

function createNativeAdapter() {
  const call = (op, payload) => invoke(`engine.${op}`, payload);
  return {
    mode: "native",
    open: (path) => call("openFile", { path }),
    listDir: (path) => call("listDir", { path }),
    setRoot: (path) => call("setRoot", { path }),
    page: (p) => call("page", p),
    poll: (p) => call("poll", p),
    setFollow: (p) => call("setFollow", p),
    setEncoding: (p) => call("setEncoding", p),
    stats: (p) => call("stats", p),
    searchStart: (p) => call("searchStart", p),
    searchStatus: (p) => call("searchStatus", p),
    searchMatches: (p) => call("searchMatches", p),
    searchCancel: (p) => call("searchCancel", p),
    close: (p) => call("close", p),
  };
}

// ---------- tabs -------------------------------------------------------------

function createTab({ mode, name, path, adapter, saved }) {
  const tab = {
    id: state.nextTabId++,
    mode,
    name: name || "未命名",
    path: path || null,
    size: (saved && saved.size) || 0,
    encoding: (saved && saved.encoding) || "utf-8",
    follow: Boolean(saved && saved.follow),
    levels: saved && Array.isArray(saved.levels) && saved.levels.length ? new Set(saved.levels) : null,
    excludedLevels:
      saved && Array.isArray(saved.excludeLevels) && saved.excludeLevels.length ? new Set(saved.excludeLevels) : null,
    lastLine: (saved && saved.line) || 1,
    totalLines: 0,
    indexDone: false,
    stats: { error: 0, warn: 0, info: 0, debug: 0 },
    search: null,
    adapter,
    renderToken: 0,
    window: null, // { from, to, lines }
    feedFrom: 1,
    feedCount: 0,
    tailSeen: 0,
    error: null,
  };
  state.tabs.push(tab);
  renderTabs();
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  try {
    tab.adapter.close({ fileId: tab.fileId });
  } catch {
    // best effort
  }
  state.tabs.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.tabs[Math.max(0, idx - 1)];
    state.activeId = next ? next.id : null;
  }
  renderTabs();
  activateView();
  scheduleSaveState();
}

function activateTab(id) {
  state.activeId = id;
  renderTabs();
  activateView();
  scheduleSaveState();
}

function renderTabs() {
  const box = $("tabs");
  box.textContent = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = `tab${tab.id === state.activeId ? " active" : ""}`;
    const name = document.createElement("span");
    name.className = "t-name";
    name.textContent = tab.name;
    name.title = tab.path || tab.name;
    const close = document.createElement("button");
    close.className = "t-close";
    close.textContent = "✕";
    close.title = "关闭";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.append(name, close);
    el.addEventListener("click", () => activateTab(tab.id));
    box.append(el);
  }
  $("emptyState").style.display = state.tabs.length ? "none" : "flex";
  $("filebar").style.display = state.tabs.length ? "flex" : "none";
}

// ---------- view rendering ---------------------------------------------------

function applyFont() {
  document.documentElement.style.setProperty("--row-fs", `${state.fontSize}px`);
  rowH = state.fontSize + 8;
  document.documentElement.style.setProperty("--row-h", `${rowH}px`);
  localStorage.setItem("lv.fontSize", String(state.fontSize));
  document.documentElement.style.setProperty(
    "--log-font",
    state.fontFamily === "default" ? '"Cascadia Mono", Consolas, "SF Mono", Menlo, "Courier New", monospace' : state.fontFamily,
  );
  localStorage.setItem("lv.fontFamily", state.fontFamily);
  const tab = activeTab();
  if (tab) renderWindow(tab, hasLevelFilter(tab) ? tab.feedFrom : lineAtScroll());
}

function lineAtScroll() {
  return Math.max(1, Math.floor(scroller.scrollTop / rowH) + 1);
}

function visibleCount() {
  return Math.max(1, Math.ceil(scroller.clientHeight / rowH));
}

function spacerHeight(tab) {
  const lines = hasLevelFilter(tab) ? tab.feedCount : Math.max(tab.totalLines, 1);
  return Math.max(lines, 1) * rowH;
}

function updateSpacer(tab) {
  spacer.style.height = `${spacerHeight(tab)}px`;
}

function levelClass(line) {
  const level = LogLevel.detectLevel(line);
  return level && level !== "other" ? ` lv-${level}` : "";
}

function buildText(tab, text) {
  // returns a DocumentFragment with <mark> highlights when a search is active
  const frag = document.createDocumentFragment();
  const s = tab && tab.search && tab.search.query ? tab.search : null;
  if (!s) {
    frag.append(text);
    return frag;
  }
  let terms;
  try {
    terms = LogQuery.parseQuery(s.query, { isRegex: s.isRegex }).includeTerms;
  } catch {
    terms = [];
  }
  const ranges = [];
  for (const term of terms) {
    if (s.isRegex) {
      try {
        LogQuery.assertSafeRegex(term);
        const re = new RegExp(term, s.caseSensitive ? "g" : "gi");
        let m;
        while ((m = re.exec(text)) && ranges.length < 200) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          ranges.push([m.index, m.index + m[0].length]);
        }
      } catch {
        // The engine reports invalid expressions; a stale row simply has no mark.
      }
    } else {
      const hay = s.caseSensitive ? text : text.toLowerCase();
      const needle = s.caseSensitive ? term : term.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx !== -1 && ranges.length < 200) {
        ranges.push([idx, idx + needle.length]);
        idx = hay.indexOf(needle, idx + Math.max(needle.length, 1));
      }
    }
  }
  if (!ranges.length) {
    frag.append(text);
    return frag;
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) frag.append(text.slice(pos, a));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(a, b);
    frag.append(mark);
    pos = b;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  return frag;
}

function paintRows(tab, rows, { absolute, offset = 0 }) {
  spacer.textContent = "";
  const currentLine = tab.search && tab.search.current >= 0 && tab.search.currentLine ? tab.search.currentLine : null;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    const row = document.createElement("div");
    row.className = `row${levelClass(item.text)}${currentLine === item.no ? " current" : ""}`;
    const top = absolute ? (item.no - 1) * rowH : (offset + i) * rowH;
    row.style.top = `${top}px`;
    const lno = document.createElement("div");
    lno.className = "lno";
    lno.textContent = item.no;
    lno.title = "点击复制整行";
    lno.addEventListener("click", () => copyLine(item.text, item.no));
    const ltxt = document.createElement("div");
    ltxt.className = "ltxt";
    ltxt.append(buildText(tab, item.text));
    ltxt.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtxMenu(e, item.text);
    });
    row.append(lno, ltxt);
    frag.append(row);
  }
  spacer.append(frag);
}

function renderWindow(tab, fromLine) {
  if (hasLevelFilter(tab)) {
    loadMoreFiltered(tab);
    renderFilteredViewport(tab);
    return;
  }
  fromLine = Math.max(1, Math.floor(fromLine) || 1);
  const token = (tab.renderToken = (tab.renderToken || 0) + 1);
  const count = visibleCount() + OVERSCAN * 2;
  const from = Math.max(1, fromLine - OVERSCAN);
  tab.adapter
    .page({ fileId: tab.fileId, fromLine: from, count, levels: null })
    .then((res) => {
      if (token !== tab.renderToken || state.activeId !== tab.id) return;
      tab.totalLines = res.totalLines;
      tab.indexDone = res.indexDone;
      tab.size = res.size;
      tab.stats = res.stats;
      tab.window = { from, lines: res.lines, eof: res.eof, hasMore: res.hasMore };
      updateBadges(tab);
      updateStatus(tab);
      if (hasLevelFilter(tab)) {
        // filtered feed rows render sequentially with original line numbers
        const existing = tab.feedRows || [];
        const merged = dedupeAppend(existing, res.lines);
        tab.feedRows = merged;
        tab.feedCount = merged.length;
        tab.feedFrom = merged.length ? merged[merged.length - 1].no + 1 : res.scanEndLine || tab.feedFrom;
        tab.paintedFeed = merged.length;
        tab.filterEof = Boolean(res.eof);
        updateSpacer(tab);
        paintRows(tab, merged, { absolute: false });
      } else {
        updateSpacer(tab);
        paintRows(tab, res.lines, { absolute: true });
        if (res.eof && !res.lines.length && fromLine > 1) {
          // scrolled past EOF (index lag) — pull back to the indexed tail
          scroller.scrollTop = Math.max(0, res.totalLines * rowH - scroller.clientHeight);
        }
      }
      scheduleSaveState();
    })
    .catch((err) => toast(`读取失败: ${err.message || err}`));
}

function dedupeAppend(existing, fresh) {
  if (!existing.length) return fresh.slice();
  const lastNo = existing[existing.length - 1].no;
  return existing.concat(fresh.filter((x) => x.no > lastNo));
}

function renderFilteredViewport(tab) {
  updateSpacer(tab);
  paintRows(tab, tab.feedRows || [], { absolute: false });
}

function renderFilteredReset(tab) {
  tab.feedRows = [];
  tab.feedCount = 0;
  tab.feedFrom = 1;
  tab.paintedFeed = 0;
  tab.filterEof = false;
  scroller.scrollTop = 0;
  updateSpacer(tab);
  loadMoreFiltered(tab);
}

/** Load the next batch of level-matching rows (also continues past empty windows). */
async function loadMoreFiltered(tab) {
  if (!hasLevelFilter(tab) || tab.loadingMore || tab.filterEof) return;
  tab.loadingMore = true;
  try {
    for (let guard = 0; guard < 30; guard += 1) {
      const res = await tab.adapter.page({
        fileId: tab.fileId,
        fromLine: tab.feedFrom,
        count: visibleCount() * 2,
        levels: levelFilterPayload(tab),
      });
      tab.totalLines = res.totalLines;
      tab.indexDone = res.indexDone;
      tab.size = res.size;
      tab.stats = res.stats;
      const existing = tab.feedRows || [];
      const prevPainted = tab.paintedFeed || 0;
      const merged = dedupeAppend(existing, res.lines);
      const newRows = merged.slice(existing.length);
      tab.feedRows = merged;
      tab.feedCount = merged.length;
      tab.feedFrom = merged.length ? merged[merged.length - 1].no + 1 : res.scanEndLine || tab.feedFrom;
      tab.filterEof = Boolean(res.eof);
      updateSpacer(tab);
      if (prevPainted === existing.length && prevPainted > 0) {
        paintFilteredAppend(tab, newRows);
      } else {
        paintRows(tab, merged, { absolute: false });
        tab.paintedFeed = merged.length;
      }
      updateBadges(tab);
      updateStatus(tab);
      if (res.eof) break;
      if (newRows.length > 0) break; // painted content; wait for the next scroll
      if (!res.scanEndLine || res.scanEndLine <= tab.feedFrom) break; // no progress
      tab.feedFrom = res.scanEndLine; // empty window: keep scanning
    }
  } catch (err) {
    toast(`过滤视图加载失败: ${err.message || err}`);
  } finally {
    tab.loadingMore = false;
  }
}

function paintFilteredAppend(tab, newRows) {
  if (!newRows.length) return;
  const currentLine = tab.search && tab.search.current >= 0 && tab.search.currentLine ? tab.search.currentLine : null;
  const frag = document.createDocumentFragment();
  const startIdx = tab.paintedFeed || 0;
  newRows.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = `row${levelClass(item.text)}${currentLine === item.no ? " current" : ""}`;
    row.style.top = `${(startIdx + i) * rowH}px`;
    const lno = document.createElement("div");
    lno.className = "lno";
    lno.textContent = item.no;
    lno.title = "点击复制整行";
    lno.addEventListener("click", () => copyLine(item.text, item.no));
    const ltxt = document.createElement("div");
    ltxt.className = "ltxt";
    ltxt.append(buildText(tab, item.text));
    ltxt.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtxMenu(e, item.text);
    });
    row.append(lno, ltxt);
    frag.append(row);
  });
  spacer.append(frag);
  tab.paintedFeed = startIdx + newRows.length;
}

// follow-mode helpers ---------------------------------------------------------

function scrollToTail(tab, { enableFollow = false } = {}) {
  if (hasLevelFilter(tab)) return;
  const target = Math.max(1, tab.totalLines - visibleCount() + 1);
  scroller.scrollTop = (target - 1) * rowH;
  renderWindow(tab, target);
  if (enableFollow && !tab.follow) setFollow(tab, true);
}

async function setFollow(tab, on) {
  tab.follow = Boolean(on);
  try {
    await tab.adapter.setFollow({ fileId: tab.fileId, follow: tab.follow });
  } catch {
    // The host owns the follow handle; a closed file is reported on poll.
  }
  updateFollowState(tab);
  if (tab.follow) scrollToTail(tab);
  scheduleSaveState();
}

function updateFollowState(tab) {
  const el = $("stFollow");
  el.classList.remove("on", "paused");
  if (!tab) {
    el.textContent = "";
    return;
  }
  if (tab.follow) {
    el.classList.add("on");
    el.textContent = "实时跟随中";
    $("btnFollow").classList.add("toggled");
  } else {
    el.textContent = tab.mode === "native" ? "跟随已暂停" : "";
    $("btnFollow").classList.remove("toggled");
  }
}

// ---------- poll loop --------------------------------------------------------

async function tick() {
  for (const tab of state.tabs) {
    if (tab.mode === "native" && tab.fileId) {
      try {
        const res = await tab.adapter.poll({ fileId: tab.fileId, sinceLine: tab.lastLine });
        applyPoll(tab, res);
      } catch (err) {
        if (String(err && err.message).includes("not open")) {
          tab.error = "文件句柄已失效";
        }
      }
    }
  }
  const active = activeTab();
  if (active && active.search && active.search.status === "running") {
    try {
      await pollSearch(active);
    } catch {
      // job pruned
    }
  }
}

function applyPoll(tab, res) {
  if (res.missing) {
    if (tab.error !== "missing") {
      tab.error = "missing";
      if (tab.id === state.activeId) {
        toast(`文件已不存在: ${tab.name}`);
        $("stLines").textContent = "文件已丢失";
      }
    }
    return;
  }
  tab.error = null;
  tab.size = res.size;
  tab.totalLines = res.totalLines;
  tab.indexDone = res.indexDone;
  tab.stats = res.stats;
  const rotated = res.rotated || (res.events || []).some((e) => e.type === "rotated");
  if (tab.id !== state.activeId) {
    // Keep bookkeeping only; UI belongs to the active tab.
    for (const ev of res.events || []) {
      if (ev.type === "append" || ev.type === "catchup") {
        tab.lastLine = ev.totalLines;
        tab.totalLines = ev.totalLines;
      } else if (ev.type === "rotated") {
        tab.lastLine = 0;
        tab.search = null;
      }
    }
    return;
  }
  if (rotated) {
    toast(`日志已轮转，重新加载: ${tab.name}`);
    tab.lastLine = 0;
    tab.search = null;
    updateSearchBar(tab);
    if (tab.follow) {
      renderWindow(tab, 1);
      setTimeout(() => scrollToTail(tab), 600);
    } else {
      renderWindow(tab, 1);
    }
    updateBadges(tab);
    updateStatus(tab);
    return;
  }
  for (const ev of res.events || []) {
    if (ev.type === "append") {
      tab.lastLine = ev.totalLines;
      tab.totalLines = ev.totalLines;
      if (tab.follow && atBottom()) {
        if (hasLevelFilter(tab)) loadMoreFiltered(tab);
        else {
          updateSpacer(tab);
          renderWindow(tab, Math.max(1, tab.totalLines - visibleCount() + 1));
        }
        scroller.scrollTop = scroller.scrollHeight;
      } else if (!tab.follow) {
        showJumpChip(ev.totalLines - (tab.tailSeen || tab.lastLine));
      } else {
        updateSpacer(tab);
      }
    } else if (ev.type === "catchup") {
      tab.lastLine = ev.totalLines;
      if (tab.follow) renderWindow(tab, Math.max(1, tab.totalLines - visibleCount() + 1));
      else showJumpChip(1);
    }
  }
  updateBadges(tab);
  updateStatus(tab);
}

function applyStats(tab, res) {
  tab.stats = res.stats;
  tab.totalLines = res.totalLines;
  tab.indexDone = res.indexDone;
  if (!hasLevelFilter(tab)) updateSpacer(tab);
  updateBadges(tab);
  updateStatus(tab);
}

function showJumpChip(newCount) {
  const chip = $("jumpChip");
  chip.style.display = "flex";
  chip.textContent = `↓ ${newCount > 0 ? `${newCount} 行新日志，` : ""}点击回到底部`;
}

function hideJumpChip() {
  $("jumpChip").style.display = "none";
}

// ---------- badges & status --------------------------------------------------

function updateBadges(tab) {
  const map = { error: 0, warn: 0, info: 0, debug: 0 };
  Object.assign(map, tab.stats || {});
  for (const el of $("badges").children) {
    const lv = el.dataset.level;
    el.querySelector("b").textContent = String(map[lv] || 0);
    const stateName = badgeState(tab, lv);
    el.dataset.state = stateName;
    el.classList.toggle("on", stateName === "include");
    el.classList.toggle("exclude", stateName === "exclude");
    el.title = stateName === "include" ? "仅显示此等级（再次点击改为排除）" : stateName === "exclude" ? "排除该等级（再次点击取消）" : "点击仅显示此等级";
  }
  const idx = $("idxProgress");
  if (!tab || !tab.fileId) {
    idx.textContent = "";
    return;
  }
  if (tab.indexDone) idx.textContent = "";
  else idx.textContent = `索引中 L${tab.totalLines}…`;
}

function updateStatus(tab) {
  if (!tab) {
    $("stPos").textContent = "—";
    $("stLines").textContent = "";
    $("stSize").textContent = "";
    return;
  }
  if (hasLevelFilter(tab)) {
    $("stPos").textContent = `过滤视图 ${tab.feedCount} 行`;
    $("stLines").textContent = `源文件已索引 L${tab.totalLines}${tab.indexDone ? "" : "+"}`;
  } else {
    const pos = lineAtScroll() + visibleCount() - 1;
    $("stPos").textContent = `L ${lineAtScroll()}–${Math.min(pos, Math.max(tab.totalLines, 1))}`;
    $("stLines").textContent = `共 ${tab.totalLines} 行${tab.indexDone ? "" : "（索引中…）"}`;
  }
  $("stSize").textContent = fmtSize(tab.size);
  $("encodingSel").value = tab.encoding;
  updateFollowState(tab);
}

// ---------- search -----------------------------------------------------------

function startSearch() {
  const tab = activeTab();
  if (!tab) return;
  const query = $("searchInput").value.trim();
  if (!query) return;
  const isRegex = $("cbRegex").checked;
  const payload = {
    fileId: tab.fileId,
    query,
    isRegex,
    caseSensitive: $("cbCase").checked,
  };
  tab.adapter
    .searchStart(payload)
    .then((res) => {
      tab.search = {
        jobId: res.jobId,
        query,
        isRegex: payload.isRegex,
        caseSensitive: payload.caseSensitive,
        status: "running",
        matchCount: 0,
        stored: 0,
        current: -1,
        currentLine: null,
        cache: null,
      };
      updateSearchBar(tab);
      repaintCurrentWindow(tab);
    })
    .catch((err) => toast(`搜索失败: ${err.message || err}`));
}

async function pollSearch(tab) {
  if (!tab.search || !tab.search.jobId) return;
  try {
    const st = await tab.adapter.searchStatus({ fileId: tab.fileId, jobId: tab.search.jobId });
    tab.search.status = st.status;
    tab.search.matchCount = st.matchCount;
    tab.search.stored = st.storedMatches;
    if (st.error) tab.search.error = st.error;
    updateSearchBar(tab);
    if (st.status !== "running") await jumpMatch(tab, tab.search.current < 0 ? 0 : tab.search.current);
  } catch {
    // job pruned or file closed
  }
}

function updateSearchBar(tab) {
  const s = tab && tab.search;
  const el = $("searchState");
  const prev = $("btnPrevMatch");
  const next = $("btnNextMatch");
  if (!s) {
    el.textContent = "";
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const navigable = Math.min(s.matchCount, s.stored || 0);
  prev.disabled = navigable === 0;
  next.disabled = navigable === 0;
  if (s.status === "running") {
    el.textContent = `扫描中 · 已命中 ${s.matchCount}`;
  } else if (s.status === "cancelled") {
    el.textContent = "已取消";
  } else if (s.status === "error") {
    el.textContent = s.error || "搜索失败";
  } else {
    const cur = s.current >= 0 ? ` · ${s.current + 1}/${navigable}` : "";
    const capNote = s.stored < s.matchCount ? `（仅定位前 ${s.stored} 处）` : "";
    el.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `命中 ${s.matchCount}`;
    el.append(b, document.createTextNode(`${cur}${capNote}`));
  }
}

function repaintCurrentWindow(tab) {
  if (hasLevelFilter(tab)) {
    renderFilteredViewport(tab);
    return;
  }
  if (!tab.window) return;
  paintRows(tab, hasLevelFilter(tab) ? tab.feedRows || [] : tab.window.lines, { absolute: !hasLevelFilter(tab) });
}

async function jumpMatch(tab, index) {
  const s = tab.search;
  if (!s || !s.jobId) return;
  if (s.matchCount === 0) {
    updateSearchBar(tab);
    return;
  }
  const stored = s.stored || 0;
  if (stored === 0) return;
  index = ((Math.floor(index) % stored) + stored) % stored;
  const windowStart = Math.max(0, index - 60);
  const res = await tab.adapter.searchMatches({ fileId: tab.fileId, jobId: s.jobId, offset: windowStart, limit: 160 });
  s.cache = { offset: windowStart, items: res.matches };
  const item = res.matches[index - windowStart];
  s.current = index;
  s.currentLine = item ? item.line : null;
  updateSearchBar(tab);
  if (item) {
    if (hasLevelFilter(tab)) {
      let visibleIndex = (tab.feedRows || []).findIndex((row) => row.no === item.line);
      for (let guard = 0; visibleIndex < 0 && guard < 100 && !tab.filterEof; guard += 1) {
        const before = tab.feedRows ? tab.feedRows.length : 0;
        await loadMoreFiltered(tab);
        if ((tab.feedRows ? tab.feedRows.length : 0) === before) break;
        visibleIndex = (tab.feedRows || []).findIndex((row) => row.no === item.line);
      }
      if (visibleIndex >= 0) {
        scroller.scrollTop = Math.max(0, visibleIndex * rowH - scroller.clientHeight / 2);
        renderFilteredViewport(tab);
      } else {
        toast(`命中位于 L${item.line}，不在当前等级过滤视图`);
      }
    } else {
      scroller.scrollTop = Math.max(0, (item.line - 1) * rowH - scroller.clientHeight / 2);
      renderWindow(tab, item.line - Math.floor(visibleCount() / 2));
    }
  }
}

function clearSearch(tab) {
  if (!tab || !tab.search) return;
  tab.adapter.searchCancel({ fileId: tab.fileId, jobId: tab.search.jobId }).catch(() => {});
  tab.search = null;
  updateSearchBar(tab);
  repaintCurrentWindow(tab);
}

async function jumpToLine(tab, target) {
  if (!tab || !Number.isInteger(target) || target < 1) return;
  if (!hasLevelFilter(tab)) {
    if (tab.indexDone && target > tab.totalLines) {
      toast(`行号超出范围（共 ${tab.totalLines} 行）`);
      return;
    }
    tab.lastLine = target;
    scroller.scrollTop = (target - 1) * rowH;
    renderWindow(tab, Math.max(1, target - Math.floor(visibleCount() / 2)));
    return;
  }
  for (let guard = 0; guard < 100 && !tab.filterEof; guard += 1) {
    const found = (tab.feedRows || []).findIndex((item) => item.no >= target);
    if (found >= 0) {
      scroller.scrollTop = Math.max(0, found * rowH - scroller.clientHeight / 2);
      renderFilteredViewport(tab);
      updateStatus(tab);
      return;
    }
    const before = tab.feedRows ? tab.feedRows.length : 0;
    await loadMoreFiltered(tab);
    if ((tab.feedRows ? tab.feedRows.length : 0) === before) break;
  }
  const found = (tab.feedRows || []).findIndex((item) => item.no >= target);
  if (found >= 0) {
    scroller.scrollTop = Math.max(0, found * rowH - scroller.clientHeight / 2);
    renderFilteredViewport(tab);
  } else {
    toast(`过滤视图中没有不小于 L${target} 的行`);
  }
}

function promptJumpToLine() {
  const tab = activeTab();
  if (!tab) return;
  const raw = window.prompt("跳转到行号", String(lineAtScroll()));
  if (raw === null) return;
  const target = Number(raw.trim());
  if (!Number.isSafeInteger(target) || target < 1) {
    toast("请输入正整数行号");
    return;
  }
  jumpToLine(tab, target).catch((err) => toast(`跳转失败: ${err.message || err}`));
}

// ---------- tabs activation & view ------------------------------------------

function activateView() {
  const tab = activeTab();
  hideJumpChip();
  $("searchInput").value = tab && tab.search ? tab.search.query : "";
  updateSearchBar(tab);
  if (!tab) {
    spacer.textContent = "";
    spacer.style.height = "0px";
    updateStatus(null);
    updateBadges({ stats: {}, levels: null });
    updateFollowState(null);
    return;
  }
  if (hasLevelFilter(tab)) {
    if (!tab.feedRows) renderFilteredReset(tab);
    else {
      tab.paintedFeed = tab.feedRows.length;
      updateSpacer(tab);
      paintRows(tab, tab.feedRows, { absolute: false });
    }
  } else {
    renderWindow(tab, tab.lastLine || 1);
    if (tab.follow) setTimeout(() => scrollToTail(tab), 0);
  }
  updateStatus(tab);
  updateBadges(tab);
}

// ---------- open files -------------------------------------------------------

let dirCtx = { path: null, selected: new Map() };

/**
 * Pick a folder (only host gesture available), then multi-select files
 * inside that exact directory. No subdirectory walk, no parent navigation.
 */
async function openFilesFlow() {
  let dir;
  try {
    dir = await bridge.invoke("fs.requestDirectory");
  } catch (err) {
    toast(`选择目录失败: ${err.message || err}`);
    return;
  }
  if (!dir) return;
  try {
    await invoke("engine.setRoot", { path: "" });
  } catch (err) {
    toast(`绑定目录失败: ${err.message || err}`);
    return;
  }
  dirCtx = { path: "", selected: new Map() };
  await loadFileList("");
  $("dirOverlay").classList.add("show");
}

async function loadFileList(path) {
  const res = await invoke("engine.listDir", { path });
  dirCtx.path = res.path;
  dirCtx.selected.clear();
  const list = $("fileList");
  list.textContent = "";
  $("dirPath").textContent = res.path || "当前选择的目录";
  if (!res.entries.length) {
    const empty = document.createElement("div");
    empty.className = "f-row";
    empty.style.color = "var(--text-dim)";
    empty.textContent = "该目录下没有可打开的文件";
    list.append(empty);
  }
  for (const ent of res.entries) {
    if (ent.isDirectory) continue;
    const row = document.createElement("div");
    row.className = "f-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const name = document.createElement("span");
    name.textContent = ent.name;
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    const size = document.createElement("span");
    size.className = "f-size";
    size.textContent = fmtSize(ent.size);
    const time = document.createElement("span");
    time.className = "f-time";
    time.textContent = fmtTime(ent.mtimeMs);
    cb.addEventListener("change", () => {
      if (cb.checked) dirCtx.selected.set(ent.path, ent);
      else dirCtx.selected.delete(ent.path);
      $("dirSelInfo").textContent = dirCtx.selected.size ? `已选择 ${dirCtx.selected.size} 个文件` : "未选择";
      $("dirOpen").disabled = dirCtx.selected.size === 0;
    });
    row.append(cb, name, size, time);
    row.addEventListener("click", (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      }
    });
    list.append(row);
  }
  $("dirSelInfo").textContent = "未选择";
  $("dirOpen").disabled = true;
}

async function openSelectedFiles() {
  const paths = [...dirCtx.selected.keys()];
  $("dirOverlay").classList.remove("show");
  for (const p of paths) {
    await openNativeFile(p);
  }
}

async function openNativeFile(path) {
  try {
    const res = await invoke("engine.openFile", { path });
    const existing = state.tabs.find((t) => t.mode === "native" && t.path === path);
    if (existing) {
      existing.fileId = res.fileId;
      activateTab(existing.id);
      return existing;
    }
    const tab = createTab({ mode: "native", name: res.name, path, adapter: createNativeAdapter() });
    tab.fileId = res.fileId;
    tab.size = res.size;
    tab.totalLines = res.totalLines;
    tab.indexDone = res.indexDone;
    tab.encoding = res.encoding;
    tab.stats = res.stats;
    activateTab(tab.id);
    return tab;
  } catch (err) {
    toast(`打开失败: ${err.message || err}`);
    return null;
  }
}

async function openDroppedFile(file) {
  const key = `${file.name}:${file.size}`;
  const existing = state.tabs.find((t) => t.dropKey === key);
  if (existing) {
    activateTab(existing.id);
    return;
  }
  const path = bridge.getDroppedFilePath(file);
  if (!path) {
    toast("无法解析拖入文件路径");
    return;
  }
  let grant;
  try {
    grant = await bridge.invoke("fs.registerDropped", { path });
  } catch (err) {
    toast(`拖入文件授权失败: ${err.message || err}`);
    return;
  }
  const adapter = createNativeAdapter();
  const tab = createTab({ mode: "native", name: file.name, adapter, saved: null });
  tab.dropKey = key;
  invoke("engine.openDropped", { path, grantId: grant.grantId })
    .then((res) => {
      tab.fileId = res.fileId;
      tab.path = null;
      tab.size = res.size;
      tab.totalLines = res.totalLines;
      tab.indexDone = res.indexDone;
      tab.encoding = res.encoding;
      tab.stats = res.stats;
      activateTab(tab.id);
      toast(`已打开拖入文件: ${file.name}`);
    })
    .catch((err) => {
      toast(`拖入文件打开失败: ${err.message || err}`);
      closeTab(tab.id);
    });
}

// ---------- clipboard & context menu ----------------------------------------

async function copyLine(text, no) {
  try {
    await bridge.invoke("clipboard.writeText", { text });
    toast(`已复制 L${no}`);
  } catch (err) {
    toast(`复制失败: ${err.message || err}`);
  }
}

function openCtxMenu(e, lineText) {
  const menu = $("ctxMenu");
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 90)}px`;
  menu.classList.add("show");
  $("ctxCopyLine").onclick = () => {
    menu.classList.remove("show");
    copyLine(lineText, "");
  };
  $("ctxCopySel").onclick = () => {
    menu.classList.remove("show");
    const sel = String(document.getSelection());
    if (sel) bridge.invoke("clipboard.writeText", { text: sel }).then(() => toast("已复制选中内容"));
  };
}

// ---------- theme ------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function currentHostTheme() {
  return document.documentElement.classList.contains("light") ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)
    ? "light"
    : "dark";
}

// ---------- events -----------------------------------------------------------

function applyAppearance(appearance) {
  if (state.theme) return;
  const base = appearance && appearance.base;
  if (base === "light" || base === "dark") applyTheme(base);
  else applyTheme(currentHostTheme());
}

function bindEvents() {
  $("btnAdd").addEventListener("click", openFilesFlow);
  $("btnOpenDir").addEventListener("click", openFilesFlow);
  $("btnEmptyOpen").addEventListener("click", openFilesFlow);
  $("dirClose").addEventListener("click", () => $("dirOverlay").classList.remove("show"));
  $("dirCancel").addEventListener("click", () => $("dirOverlay").classList.remove("show"));
  $("dirOpen").addEventListener("click", openSelectedFiles);
  $("btnJumpLine").addEventListener("click", promptJumpToLine);

  $("btnHead").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    if (hasLevelFilter(tab)) renderFilteredReset(tab);
    else {
      scroller.scrollTop = 0;
      renderWindow(tab, 1);
    }
  });
  $("btnTail").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || hasLevelFilter(tab)) return;
    scrollToTail(tab);
  });
  $("btnFollow").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.mode !== "native") return;
    setFollow(tab, !tab.follow);
  });
  $("btnFontDown").addEventListener("click", () => {
    state.fontSize = Math.max(10, state.fontSize - 1);
    applyFont();
  });
  $("btnFontUp").addEventListener("click", () => {
    state.fontSize = Math.min(22, state.fontSize + 1);
    applyFont();
  });
  $("fontFamilySel").value = state.fontFamily;
  $("fontFamilySel").addEventListener("change", () => {
    state.fontFamily = $("fontFamilySel").value;
    applyFont();
  });
  $("btnTheme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    state.theme = next;
    localStorage.setItem("lv.theme", next);
    applyTheme(next);
  });

  $("btnSearch").addEventListener("click", startSearch);
  $("btnPrevMatch").addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.search) jumpMatch(tab, (tab.search.current < 0 ? tab.search.stored : tab.search.current) - 1);
  });
  $("btnNextMatch").addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.search) jumpMatch(tab, (tab.search.current < 0 ? -1 : tab.search.current) + 1);
  });
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSearch();
  });
  $("btnSearchClose").addEventListener("click", () => clearSearch(activeTab()));

  for (const el of $("badges").children) {
    el.addEventListener("click", () => {
      const tab = activeTab();
      if (!tab) return;
      const lv = el.dataset.level;
      const current = badgeState(tab, lv);
      if (!tab.levels) tab.levels = new Set();
      if (!tab.excludedLevels) tab.excludedLevels = new Set();
      if (current === "neutral") {
        tab.levels.add(lv);
      } else if (current === "include") {
        tab.levels.delete(lv);
        tab.excludedLevels.add(lv);
      } else {
        tab.excludedLevels.delete(lv);
      }
      if (!tab.levels.size) tab.levels = null;
      if (!tab.excludedLevels.size) tab.excludedLevels = null;
      if (hasLevelFilter(tab)) renderFilteredReset(tab);
      else {
        scroller.scrollTop = Math.max(0, (tab.lastLine - visibleCount()) * rowH);
        renderWindow(tab, Math.max(1, tab.lastLine - visibleCount() + 1));
      }
      updateBadges(tab);
      updateStatus(tab);
      scheduleSaveState();
    });
  }

  $("encodingSel").addEventListener("change", () => {
    const tab = activeTab();
    if (!tab) return;
    const enc = $("encodingSel").value;
    tab.adapter
      .setEncoding({ fileId: tab.fileId, encoding: enc })
      .then(() => {
        tab.encoding = enc;
        renderWindow(tab, hasLevelFilter(tab) ? tab.feedFrom : lineAtScroll());
        scheduleSaveState();
      })
      .catch((err) => toast(`切换编码失败: ${err.message || err}`));
  });

  scroller.addEventListener("scroll", () => {
    const tab = activeTab();
    if (!tab) return;
    if (hasLevelFilter(tab)) {
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80) {
        loadMoreFiltered(tab);
      }
      updateStatus(tab);
      return;
    }
    if (tab.follow && !atBottom()) {
      setFollow(tab, false);
      showJumpChip(0);
    }
    if (atBottom() && tab.follow) hideJumpChip();
    const from = lineAtScroll();
    if (!tab.window || Math.abs(from - tab.window.from) > Math.floor(visibleCount() / 2)) {
      renderWindow(tab, from);
    }
    updateStatus(tab);
    tab.tailSeen = Math.max(tab.tailSeen || 0, lineAtScroll() + visibleCount());
  });

  $("jumpChip").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    hideJumpChip();
    if (tab.mode === "native") setFollow(tab, true);
    else scrollToTail(tab);
  });

  // drag & drop
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    $("dropMask").style.display = "flex";
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("dropMask").style.display = "none";
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dropMask").style.display = "none";
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    for (const f of files) openDroppedFile(f);
  });

  // context menu dismiss
  document.addEventListener("click", (e) => {
    for (const id of ["ctxMenu"]) {
      const menu = $(id);
      if (menu.classList.contains("show") && !menu.contains(e.target)) menu.classList.remove("show");
    }
  });

  // keyboard
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      $("searchInput").focus();
      $("searchInput").select();
    } else if (mod && e.key.toLowerCase() === "g") {
      e.preventDefault();
      promptJumpToLine();
    } else if (e.key === "F3") {
      e.preventDefault();
      const tab = activeTab();
      if (!tab || !tab.search) return;
      jumpMatch(tab, tab.search.current + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      if ($("dirOverlay").classList.contains("show")) $("dirOverlay").classList.remove("show");
      else $("searchInput").blur();
    }
  });

  bridge.on("appearance:changed", (appearance) => {
    applyAppearance(appearance);
  });
}

// ---------- persisted state --------------------------------------------------

let saveTimer = null;
function scheduleSaveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tabs = state.tabs.map((t) => ({
      mode: t.mode,
      path: t.path,
      name: t.name,
      size: t.size,
      line: Math.max(1, t.lastLine || 1),
      encoding: t.encoding,
      follow: t.follow,
      levels: t.levels ? [...t.levels] : [],
      excludeLevels: t.excludedLevels ? [...t.excludedLevels] : [],
    }));
    try {
      await invoke("engine.saveState", { tabs, active: state.tabs.findIndex((t) => t.id === state.activeId) });
    } catch {
      // state saving is best-effort
    }
  }, 800);
}

// ---------- boot -------------------------------------------------------------

async function boot() {
  applyTheme(state.theme || currentHostTheme());
  applyFont();
  bindEvents();
  try {
    const appearance = await bridge.invoke("app.getAppearance");
    applyAppearance(appearance);
  } catch {
    // appearance channel unavailable — keep matchMedia default
  }
  try {
    const st = await invoke("engine.restoreState");
    let skipped = 0;
    for (const saved of st.tabs || []) {
      if (saved.restorable && saved.fileId) {
        const tab = createTab({ mode: "native", name: saved.name, path: saved.path, adapter: createNativeAdapter(), saved });
        tab.fileId = saved.fileId;
        tab.size = saved.size || 0;
        tab.encoding = saved.encoding || "utf-8";
        tab.follow = Boolean(saved.follow);
        tab.levels = Array.isArray(saved.levels) && saved.levels.length ? new Set(saved.levels) : null;
        tab.excludedLevels =
          Array.isArray(saved.excludeLevels) && saved.excludeLevels.length ? new Set(saved.excludeLevels) : null;
        tab.lastLine = Math.max(1, saved.line || 1);
      } else {
        skipped += 1;
      }
    }
    if (skipped) toast(`${skipped} 个上次的拖入文件需重新拖入`);
    const active = (st.tabs || [])[st.active] || state.tabs[0];
    if (active) {
      state.activeId = active.id;
      renderTabs();
      activateView();
    } else {
      renderTabs();
    }
  } catch (err) {
    toast(`恢复浏览状态失败: ${err.message || err}`);
    renderTabs();
  }
  setInterval(tick, 400);
}

boot();
