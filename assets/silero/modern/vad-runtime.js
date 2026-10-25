var NuvioSilero = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../../../../../development/silero-rust/pkg/silero_rust.js
  var silero_rust_exports = {};
  __export(silero_rust_exports, {
    G4EncoderProfiler: () => G4EncoderProfiler,
    WasmVad: () => WasmVad,
    default: () => __wbg_init,
    initSync: () => initSync
  });
  var import_meta = {};
  var G4EncoderProfiler = class {
    __destroy_into_raw() {
      const ptr = this.__wbg_ptr;
      this.__wbg_ptr = 0;
      G4EncoderProfilerFinalization.unregister(this);
      return ptr;
    }
    free() {
      const ptr = this.__destroy_into_raw();
      wasm.__wbg_g4encoderprofiler_free(ptr, 0);
    }
    /**
     * `model_bytes`: original models/silero-v6.bin (SVAD6F32 format).
     * `stft_input`: one representative 516-element STFT-magnitude vector.
     * @param {Uint8Array} model_bytes
     * @param {Float32Array} stft_input
     */
    constructor(model_bytes, stft_input) {
      const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc);
      const len0 = WASM_VECTOR_LEN;
      const ptr1 = passArrayF32ToWasm0(stft_input, wasm.__wbindgen_malloc);
      const len1 = WASM_VECTOR_LEN;
      const ret = wasm.g4encoderprofiler_new(ptr0, len0, ptr1, len1);
      if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
      }
      this.__wbg_ptr = ret[0];
      G4EncoderProfilerFinalization.register(this, this.__wbg_ptr, this);
      return this;
    }
    /**
     * Execute one selected SIMD layer repeatedly within one WASM call.
     * stage=0..3: one layer; stage=4: complete FastEncoder.
     * Returns a checksum so the optimizer cannot simply discard the work.
     * Time this method from JS with performance.now() and divide by `repeats`.
     * @param {number} stage
     * @param {number} repeats
     * @returns {number}
     */
    run_batch(stage, repeats) {
      const ret = wasm.g4encoderprofiler_run_batch(this.__wbg_ptr, stage, repeats);
      if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
      }
      return ret[0];
    }
    /**
     * Eight numbers: [max_abs0, max_tolerance_ratio0, ..., max_abs3, max_tolerance_ratio3].
     * Ratios <= 1.0 pass the same per-element tolerance used in native tests.
     * IMPORTANT: this runs real SIMD and compares against the original Conv1D,
     * using identical inputs for each individual layer.
     * @returns {Float64Array}
     */
    verify_layers() {
      const ret = wasm.g4encoderprofiler_verify_layers(this.__wbg_ptr);
      var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
      wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
      return v1;
    }
  };
  if (Symbol.dispose) G4EncoderProfiler.prototype[Symbol.dispose] = G4EncoderProfiler.prototype.free;
  var WasmVad = class {
    __destroy_into_raw() {
      const ptr = this.__wbg_ptr;
      this.__wbg_ptr = 0;
      WasmVadFinalization.unregister(this);
      return ptr;
    }
    free() {
      const ptr = this.__destroy_into_raw();
      wasm.__wbg_wasmvad_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     */
    constructor(bytes) {
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.wasmvad_new(ptr0, len0);
      if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
      }
      this.__wbg_ptr = ret[0];
      WasmVadFinalization.register(this, this.__wbg_ptr, this);
      return this;
    }
    /**
     * @param {Float32Array} samples
     * @returns {number}
     */
    process_chunk(samples) {
      const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.wasmvad_process_chunk(this.__wbg_ptr, ptr0, len0);
      if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
      }
      return ret[0];
    }
    reset() {
      wasm.wasmvad_reset(this.__wbg_ptr);
    }
  };
  if (Symbol.dispose) WasmVad.prototype[Symbol.dispose] = WasmVad.prototype.free;
  function __wbg_get_imports() {
    const import0 = {
      __proto__: null,
      __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
      },
      __wbindgen_generic_0000000000000001: function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
      },
      __wbindgen_init_externref_table: function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, void 0);
        table.set(offset + 0, void 0);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      }
    };
    return {
      __proto__: null,
      "./silero_rust_bg.js": import0
    };
  }
  var G4EncoderProfilerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
  }, unregister: () => {
  } } : new FinalizationRegistry((ptr) => wasm.__wbg_g4encoderprofiler_free(ptr, 1));
  var WasmVadFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
  }, unregister: () => {
  } } : new FinalizationRegistry((ptr) => wasm.__wbg_wasmvad_free(ptr, 1));
  function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
  }
  var cachedFloat32ArrayMemory0 = null;
  function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
      cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
  }
  var cachedFloat64ArrayMemory0 = null;
  function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
      cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
  }
  function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
  }
  var cachedUint8ArrayMemory0 = null;
  function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
  }
  function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
  }
  function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
  }
  function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
  }
  var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  cachedTextDecoder.decode();
  var MAX_SAFARI_DECODE_BYTES = 2146435072;
  var numBytesDecoded = 0;
  function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
      cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
      cachedTextDecoder.decode();
      numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
  }
  var WASM_VECTOR_LEN = 0;
  var wasmModule;
  var wasmInstance;
  var wasm;
  function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
  }
  async function __wbg_load(module, imports) {
    if (typeof Response === "function" && module instanceof Response) {
      if (!module.ok) {
        throw new Error("failed to fetch Wasm: ".concat(module.status, " ").concat(module.statusText, " fetching '").concat(module.url, "'"));
      }
      if (typeof WebAssembly.instantiateStreaming === "function") {
        try {
          return await WebAssembly.instantiateStreaming(module, imports);
        } catch (e) {
          const validResponse = expectedResponseType(module.type);
          if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
            console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
          } else {
            throw e;
          }
        }
      }
      const bytes = await module.arrayBuffer();
      return await WebAssembly.instantiate(bytes, imports);
    } else {
      const instance = await WebAssembly.instantiate(module, imports);
      if (instance instanceof WebAssembly.Instance) {
        return { instance, module };
      } else {
        return instance;
      }
    }
    function expectedResponseType(type) {
      switch (type) {
        case "basic":
        case "cors":
        case "default":
          return true;
      }
      return false;
    }
  }
  function initSync(module) {
    if (wasm !== void 0) return wasm;
    if (module !== void 0) {
      if (Object.getPrototypeOf(module) === Object.prototype) {
        ({ module } = module);
      } else {
        console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
      }
    }
    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
      module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
  }
  async function __wbg_init(module_or_path) {
    if (wasm !== void 0) return wasm;
    if (module_or_path !== void 0) {
      if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
        ({ module_or_path } = module_or_path);
      } else {
        console.warn("using deprecated parameters for the initialization function; pass a single object instead");
      }
    }
    if (module_or_path === void 0) {
      module_or_path = new URL("silero_rust_bg.wasm", import_meta.url);
    }
    const imports = __wbg_get_imports();
    if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
      module_or_path = fetch(module_or_path);
    }
    const { instance, module } = await __wbg_load(await module_or_path, imports);
    return __wbg_finalize_init(instance, module);
  }
  return __toCommonJS(silero_rust_exports);
})();
