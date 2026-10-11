import { MeasurementEngine } from "./speedtest.js";

let engine = null;
self.onmessage = async ({ data }) => {
  if (data.type === "cancel") { engine?.cancel(data.message); return; }
  if (data.type !== "start" || engine) return;
  engine = new MeasurementEngine({ onUpdate: (update) => self.postMessage({ type: "update", update }) });
  try { self.postMessage({ type: "result", result: await engine.run(data.config, data.options) }); }
  catch (error) { self.postMessage({ type: "error", name: error.name, message: error.message }); }
  finally { engine = null; }
};
