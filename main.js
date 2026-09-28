"use strict";

const { LogEngine } = require("./lib/log-engine.js");

const COMMAND_ID = "log-viewer.open";
let engine = null;

async function onLoad() {
  let dataPath = null;
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null; // state memory disabled without a data path
  }
  // All file IO is native node:fs inside this plugin process; the host is only
  // asked to resolve user-picked paths in the panel renderer.
  engine = new LogEngine({ dataPath });
  await pi.commands.register({
    id: COMMAND_ID,
    title: "日志查看器：打开",
    keywords: ["log", "日志", "viewer", "tail"],
    run: async () => {
      await pi.ui.openPanel({ title: "日志查看器" });
    },
  });
}

async function onUnload() {
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    // already gone
  }
  if (engine) {
    engine.dispose();
    engine = null;
  }
}

async function onPanelInvoke(channel, payload) {
  if (!engine) throw new Error("engine not ready");
  const op = String(channel || "").replace(/^engine\./, "");
  return engine.handle(op, payload || {});
}

module.exports = { onLoad, onUnload, onPanelInvoke };
