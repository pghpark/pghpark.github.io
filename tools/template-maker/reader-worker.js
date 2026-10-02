// Runs the text reader's two models (PaddleOCR detection and recognition) in
// the background, so the page keeps responding. paddle.js closes this worker
// after each photo: that is the only way to give ONNX Runtime's working memory
// (about 500 MB after a photo) back to the phone for editing and exporting.

let sessions = null;

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      importScripts(m.ortJs);
      ort.env.wasm.wasmPaths = m.wasmPaths;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      if (m.engine) ort.env.wasm.wasmBinary = m.engine;
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const [det, rec] = await Promise.all([ort.InferenceSession.create(m.det, opts), ort.InferenceSession.create(m.rec, opts)]);
      ort.env.wasm.wasmBinary = undefined;
      sessions = { det, rec };
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'run') {
      const s = sessions[m.model];
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', m.data, m.dims) });
      const t = out[s.outputNames[0]];
      const data = t.data.slice(); // its own buffer, so it can be handed over without copying
      t.dispose?.();
      self.postMessage({ id: m.id, ok: true, data, dims: t.dims }, [data.buffer]);
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
