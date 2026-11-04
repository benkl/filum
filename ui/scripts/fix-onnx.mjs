// Make a weight-quantized ONNX model loadable by ONNX Runtime (used for the
// OpenCV-zoo DexiNed, whose DequantizeLinear nodes use OpenCV-only blocked
// layouts): every weight is dequantized, then re-quantized the standard way —
// int8, symmetric, per output channel (axis 0, or 1 for ConvTranspose) —
// with one DequantizeLinear each. Biases and small tensors stay float.
//
//   node scripts/fix-onnx.mjs in.onnx out.onnx

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { onnx } = require("onnx-proto");
const T = onnx.TensorProto.DataType;

export function fixQuantizedModel(input, output) {
  const model = onnx.ModelProto.decode(fs.readFileSync(input));
  const g = model.graph;
  const inits = new Map(g.initializer.map((t) => [t.name, t]));
  const dims = (t) => t.dims.map((d) => Number(d));
  const numel = (s) => s.reduce((a, b) => a * b, 1);
  const values = (t) => {
    const n = numel(dims(t));
    const raw = t.rawData && t.rawData.length ? t.rawData : null;
    const view = raw ? new DataView(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (t.dataType === T.FLOAT) out[i] = raw ? view.getFloat32(i * 4, true) : t.floatData[i];
      else if (t.dataType === T.INT8) out[i] = raw ? view.getInt8(i) : t.int32Data[i];
      else if (t.dataType === T.UINT8) out[i] = raw ? view.getUint8(i) : t.int32Data[i];
      else if (t.dataType === T.INT32) out[i] = raw ? view.getInt32(i * 4, true) : t.int32Data[i];
      else if (t.dataType === T.INT16) out[i] = raw ? view.getInt16(i * 2, true) : t.int32Data[i];
      else if (t.dataType === T.UINT16) out[i] = raw ? view.getUint16(i * 2, true) : t.int32Data[i];
      else throw new Error(`dtype ${t.dataType} of ${t.name}`);
    }
    return out;
  };
  const consumers = new Map();
  for (const n of g.node) for (const i of n.input) consumers.set(i, [...(consumers.get(i) ?? []), n.opType]);

  const nodes = [];
  let count = 0;
  for (const node of g.node) {
    if (node.opType !== "DequantizeLinear") {
      nodes.push(node);
      continue;
    }
    const [xn, sn, zn] = node.input;
    const x = inits.get(xn);
    const sc = inits.get(sn);
    const zp = zn ? inits.get(zn) : null;
    if (!x || !sc || (zn && !zp)) {
      nodes.push(node);
      continue;
    }
    // 1. dequantize (per-tensor, per-axis or blocked)
    const xs = dims(x);
    const ss = dims(sc);
    const xv = values(x);
    const sv = values(sc);
    const zv = zp ? values(zp) : null;
    const attr = Object.fromEntries(node.attribute.map((a) => [a.name, Number(a.i)]));
    const rank = xs.length;
    let axis = attr.axis ?? 1;
    if (axis < 0) axis += rank;
    const block = attr.block_size ?? 0;
    const strides = xs.map((_, k) => numel(xs.slice(k + 1)));
    let sIndex;
    if (numel(ss) === 1) sIndex = () => 0;
    else if (ss.length === rank && block > 0) {
      const sstr = ss.map((_, k) => numel(ss.slice(k + 1)));
      sIndex = (i) => {
        let j = 0;
        for (let k = 0; k < rank; k++) {
          let c = Math.floor(i / strides[k]) % xs[k];
          if (k === axis) c = Math.floor(c / block);
          j += c * sstr[k];
        }
        return j;
      };
    } else {
      const len = numel(ss);
      if (xs[axis] !== len) axis = xs.findIndex((d) => d === len);
      if (axis < 0) throw new Error(`cannot place scale ${ss} on ${xs} (${node.name})`);
      sIndex = (i) => Math.floor(i / strides[axis]) % xs[axis];
    }
    const w = new Float32Array(xv.length);
    for (let i = 0; i < xv.length; i++) {
      const j = sIndex(i);
      w[i] = (xv[i] - (zv ? zv[j] : 0)) * sv[j];
    }
    const out = node.output[0];
    // 2. small tensors (biases): plain float
    if (rank < 2 || w.length < 256) {
      g.initializer.push(onnx.TensorProto.create({ name: out, dims: xs, dataType: T.FLOAT, rawData: new Uint8Array(w.buffer) }));
      count++;
      continue;
    }
    // 3. weights: int8 per output channel
    const qaxis = (consumers.get(out) ?? []).includes("ConvTranspose") ? 1 : 0;
    const ch = xs[qaxis];
    const scale = new Float32Array(ch);
    for (let i = 0; i < w.length; i++) {
      const c = Math.floor(i / strides[qaxis]) % ch;
      scale[c] = Math.max(scale[c], Math.abs(w[i]));
    }
    for (let c = 0; c < ch; c++) scale[c] = scale[c] > 0 ? scale[c] / 127 : 1;
    const q = new Int8Array(w.length);
    for (let i = 0; i < w.length; i++) {
      const c = Math.floor(i / strides[qaxis]) % ch;
      q[i] = Math.max(-127, Math.min(127, Math.round(w[i] / scale[c])));
    }
    const qn = `${out}__q`;
    const sn2 = `${out}__scale`;
    g.initializer.push(onnx.TensorProto.create({ name: qn, dims: xs, dataType: T.INT8, rawData: new Uint8Array(q.buffer) }));
    g.initializer.push(onnx.TensorProto.create({ name: sn2, dims: [ch], dataType: T.FLOAT, rawData: new Uint8Array(scale.buffer) }));
    nodes.push(
      onnx.NodeProto.create({
        name: `${node.name}__fixed`,
        opType: "DequantizeLinear",
        input: [qn, sn2],
        output: [out],
        attribute: [onnx.AttributeProto.create({ name: "axis", type: onnx.AttributeProto.AttributeType.INT, i: qaxis })],
      }),
    );
    count++;
  }
  g.node = nodes;
  const used = new Set(g.node.flatMap((n) => n.input));
  for (const o of g.output) used.add(o.name);
  g.initializer = g.initializer.filter((t) => used.has(t.name));
  fs.writeFileSync(output, onnx.ModelProto.encode(model).finish());
  return count;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const n = fixQuantizedModel(process.argv[2], process.argv[3]);
  console.log(`re-quantized ${n} tensors → ${(fs.statSync(process.argv[3]).size / 1e6).toFixed(1)} MB`);
}
