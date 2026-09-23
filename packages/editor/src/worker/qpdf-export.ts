import { EngineError } from '@pdf-editor/contracts';

const QPDF_RUNTIME_URL = '/engines/qpdf/pdf-editor-qpdf.js';
const QPDF_WASM_URL = '/engines/qpdf/pdf-editor-qpdf.wasm';
const QPDF_ABI_VERSION = 2;
const WASM32_MAX = 0xffff_ffff;
const PDE_QPDF_ALLOW_ALL = 0xff;
const POINTER_BYTES = 4;

const OPERATION_CODES = {
  decrypt: 1,
  'encrypt-aes256': 2,
  'optimize-lossless': 3,
  'optimize-images': 4,
} as const;

export type QpdfExportOptions = {
  operation: keyof typeof OPERATION_CODES;
  inputPassword?: string;
  password?: string;
  imageQuality?: number;
};

type QpdfModuleFactoryOptions = {
  locateFile?(path: string, prefix: string): string;
};

type QpdfModuleFactory = (
  options?: QpdfModuleFactoryOptions,
) => Promise<QpdfEmscriptenModule>;

type QpdfRuntimeEsModule = {
  default?: QpdfModuleFactory;
};

interface QpdfEmscriptenModule {
  HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _pde_qpdf_abi_version(): number;
  _pde_qpdf_transform(
    operation: number,
    inputData: number,
    inputSize: number,
    inputPassword: number,
    userPassword: number,
    ownerPassword: number,
    permissions: number,
    encryptMetadata: number,
    outputData: number,
    outputSize: number,
  ): number;
  _pde_qpdf_optimize_images(
    inputData: number,
    inputSize: number,
    inputPassword: number,
    imageQuality: number,
    outputData: number,
    outputSize: number,
  ): number;
  _pde_qpdf_last_error(): number;
  _pde_qpdf_free(pointer: number): void;
}

let cachedModuleFactory: QpdfModuleFactory | undefined;

export async function transformPdfExport(
  bytes: ArrayBuffer,
  options: QpdfExportOptions,
): Promise<ArrayBuffer> {
  const operation = validateRequest(bytes, options);
  const module = await createModuleInstance();
  const allocations = new WasmAllocations(module);
  let outputPointer = 0;

  try {
    try {
      const inputPointer = allocations.bytes(new Uint8Array(bytes));
      const inputPasswordPointer = options.inputPassword === undefined
        ? 0
        : allocations.string(options.inputPassword, true);
      const passwordPointer = options.operation === 'encrypt-aes256'
        ? allocations.string(options.password!, true)
        : 0;
      const outputPointerAddress = allocations.zeroed(POINTER_BYTES);
      const outputSizeAddress = allocations.zeroed(POINTER_BYTES);

      let status: number;
      try {
        status = options.operation === 'optimize-images'
          ? module._pde_qpdf_optimize_images(
            inputPointer, bytes.byteLength, inputPasswordPointer, options.imageQuality!,
            outputPointerAddress, outputSizeAddress,
          )
          : module._pde_qpdf_transform(
            operation, inputPointer, bytes.byteLength, inputPasswordPointer,
            passwordPointer, passwordPointer, PDE_QPDF_ALLOW_ALL, 1,
            outputPointerAddress, outputSizeAddress,
          );
      } catch {
        throw new EngineError('SAVE_FAILED', 'QPDF export transform failed');
      }

      outputPointer = readWasm32(module, outputPointerAddress, 'QPDF output pointer');
      const outputSize = readWasm32(module, outputSizeAddress, 'QPDF output size');
      if (status !== 0) {
        throw transformError(module, status);
      }
      if (outputPointer === 0 || outputSize === 0) {
        throw new EngineError('SAVE_FAILED', 'QPDF export transform produced no output');
      }

      // The transform may grow memory, replacing HEAPU8. Read the current view only now.
      const heap = module.HEAPU8;
      if (outputPointer > heap.byteLength || outputSize > heap.byteLength - outputPointer) {
        throw new EngineError('CORE_UNAVAILABLE', 'QPDF returned output outside WASM memory');
      }
      const result = new Uint8Array(outputSize);
      result.set(heap.subarray(outputPointer, outputPointer + outputSize));
      return result.buffer;
    } finally {
      try {
        if (outputPointer !== 0) module._pde_qpdf_free(outputPointer);
      } finally {
        allocations.free();
      }
    }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('SAVE_FAILED', 'QPDF export transform failed');
  }
}

function validateRequest(bytes: ArrayBuffer, options: QpdfExportOptions): number {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > WASM32_MAX) {
    throw new EngineError('INVALID_REQUEST', 'QPDF export input must be a non-empty wasm32 byte buffer');
  }
  if (!options || typeof options !== 'object'
      || typeof options.operation !== 'string'
      || !Object.hasOwn(OPERATION_CODES, options.operation)) {
    throw new EngineError('INVALID_REQUEST', 'Unsupported QPDF export operation');
  }
  validatePassword(options.inputPassword, 'Input password');
  validatePassword(options.password, 'Export password');
  if (options.operation === 'encrypt-aes256' && options.password === undefined) {
    throw new EngineError('INVALID_REQUEST', 'AES-256 export requires an explicit password');
  }
  if (options.operation === 'optimize-images') {
    if (!Number.isInteger(options.imageQuality) || options.imageQuality! < 1 || options.imageQuality! > 95) {
      throw new EngineError('INVALID_REQUEST', 'JPEG quality must be an integer from 1 to 95');
    }
  } else if (options.imageQuality !== undefined) {
    throw new EngineError('INVALID_REQUEST', 'JPEG quality is only used for image optimization');
  }
  return OPERATION_CODES[options.operation];
}

function validatePassword(value: string | undefined, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.includes('\0'))) {
    throw new EngineError('INVALID_REQUEST', `${label} must be a string without NUL characters`);
  }
}

async function createModuleInstance(): Promise<QpdfEmscriptenModule> {
  const runtimeUrl = sameOriginUrl(QPDF_RUNTIME_URL, 'QPDF JavaScript runtime');
  const wasmUrl = sameOriginUrl(QPDF_WASM_URL, 'QPDF WebAssembly runtime');
  const factory = await loadModuleFactory(runtimeUrl);

  let module: QpdfEmscriptenModule;
  try {
    module = await factory({
      locateFile(path) {
        return path.endsWith('.wasm') ? wasmUrl.href : new URL(path, runtimeUrl).href;
      },
    });
  } catch {
    throw new EngineError('CORE_UNAVAILABLE', 'Unable to initialize the QPDF WebAssembly runtime');
  }

  assertModule(module);
  return module;
}

async function loadModuleFactory(runtimeUrl: URL): Promise<QpdfModuleFactory> {
  if (cachedModuleFactory) return cachedModuleFactory;

  let runtimeModule: QpdfRuntimeEsModule;
  try {
    runtimeModule = await import(/* @vite-ignore */ runtimeUrl.href) as QpdfRuntimeEsModule;
  } catch {
    throw new EngineError('CORE_UNAVAILABLE', 'QPDF export runtime is not deployed');
  }
  if (typeof runtimeModule.default !== 'function') {
    throw new EngineError('CORE_UNAVAILABLE', 'QPDF runtime does not export its module factory');
  }
  cachedModuleFactory = runtimeModule.default;
  return cachedModuleFactory;
}

function assertModule(module: QpdfEmscriptenModule): void {
  const required = [
    '_malloc',
    '_free',
    '_pde_qpdf_abi_version',
    '_pde_qpdf_transform',
    '_pde_qpdf_optimize_images',
    '_pde_qpdf_last_error',
    '_pde_qpdf_free',
  ] as const;
  if (!(module?.HEAPU8 instanceof Uint8Array)
      || required.some((name) => typeof module[name] !== 'function')) {
    throw new EngineError('CORE_UNAVAILABLE', 'QPDF runtime is missing required ABI exports');
  }

  let abiVersion: number;
  try {
    abiVersion = module._pde_qpdf_abi_version();
  } catch {
    throw new EngineError('CORE_UNAVAILABLE', 'Unable to read the QPDF ABI version');
  }
  if (abiVersion !== QPDF_ABI_VERSION) {
    throw new EngineError('CORE_UNAVAILABLE', `Unsupported QPDF ABI ${abiVersion}`);
  }
}

function transformError(module: QpdfEmscriptenModule, status: number): EngineError {
  const detail = readLastError(module);
  if (status === 1) return new EngineError('INVALID_REQUEST', detail || 'Invalid QPDF export request');
  if (status >= 2 && status <= 5) {
    return new EngineError('SAVE_FAILED', detail || 'QPDF export transform failed');
  }
  return new EngineError('CORE_UNAVAILABLE', 'QPDF runtime returned an unknown status');
}

function readLastError(module: QpdfEmscriptenModule): string {
  let pointer: number;
  try {
    pointer = module._pde_qpdf_last_error();
  } catch {
    throw new EngineError('CORE_UNAVAILABLE', 'Unable to read the QPDF error state');
  }
  if (pointer === 0) return '';

  const heap = module.HEAPU8;
  if (!Number.isInteger(pointer) || pointer < 0 || pointer >= heap.byteLength) {
    throw new EngineError('CORE_UNAVAILABLE', 'QPDF returned an invalid error pointer');
  }
  let end = pointer;
  while (end < heap.byteLength && heap[end] !== 0) end += 1;
  if (end === heap.byteLength) {
    throw new EngineError('CORE_UNAVAILABLE', 'QPDF returned an unterminated error message');
  }
  return new TextDecoder().decode(heap.subarray(pointer, end));
}

function readWasm32(module: QpdfEmscriptenModule, address: number, label: string): number {
  const heap = module.HEAPU8;
  if (!Number.isInteger(address) || address < 0 || address > heap.byteLength - POINTER_BYTES) {
    throw new EngineError('CORE_UNAVAILABLE', `${label} is outside WASM memory`);
  }
  return new DataView(heap.buffer).getUint32(address, true);
}

function sameOriginUrl(path: string, label: string): URL {
  const location = globalThis.location;
  if (!location?.href) {
    throw new EngineError('CORE_UNAVAILABLE', `${label} requires a Worker location`);
  }
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) {
    throw new EngineError('INVALID_REQUEST', `${label} must be loaded from the application origin`);
  }
  return url;
}

class WasmAllocations {
  private readonly allocations: Array<{ pointer: number; size: number; sensitive: boolean }> = [];
  private readonly encoder = new TextEncoder();

  constructor(private readonly module: QpdfEmscriptenModule) {}

  bytes(value: Uint8Array): number {
    const pointer = this.allocate(value.byteLength, false);
    this.module.HEAPU8.set(value, pointer);
    return pointer;
  }

  string(value: string, sensitive: boolean): number {
    const encoded = this.encoder.encode(value);
    const pointer = this.allocate(encoded.byteLength + 1, sensitive);
    const heap = this.module.HEAPU8;
    heap.set(encoded, pointer);
    heap[pointer + encoded.byteLength] = 0;
    return pointer;
  }

  zeroed(size: number): number {
    const pointer = this.allocate(size, false);
    this.module.HEAPU8.fill(0, pointer, pointer + size);
    return pointer;
  }

  free(): void {
    for (let index = this.allocations.length - 1; index >= 0; index -= 1) {
      const allocation = this.allocations[index]!;
      if (allocation.sensitive) {
        const heap = this.module.HEAPU8;
        if (allocation.pointer <= heap.byteLength
            && allocation.size <= heap.byteLength - allocation.pointer) {
          heap.fill(0, allocation.pointer, allocation.pointer + allocation.size);
        }
      }
      this.module._free(allocation.pointer);
    }
    this.allocations.length = 0;
  }

  private allocate(size: number, sensitive: boolean): number {
    if (!Number.isSafeInteger(size) || size <= 0 || size > WASM32_MAX) {
      throw new EngineError('INVALID_REQUEST', 'QPDF export allocation exceeds the wasm32 ABI');
    }
    const pointer = this.module._malloc(size);
    const heap = this.module.HEAPU8;
    if (!Number.isInteger(pointer) || pointer <= 0
        || pointer > heap.byteLength || size > heap.byteLength - pointer) {
      throw new EngineError('SAVE_FAILED', 'QPDF could not allocate export memory');
    }
    this.allocations.push({ pointer, size, sensitive });
    return pointer;
  }
}
