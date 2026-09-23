import { EngineError } from '@pdf-editor/contracts';
import {
  createPdfCoreBinding,
  type PdfCoreEmscriptenModule,
  type WasmCoreBinding,
} from '@pdf-editor/editor/worker';

const DEFAULT_RUNTIME_URL = '/engines/pdf-core-runtime.js';

type RuntimeFactoryOptions = {
  locateFile?(path: string, prefix: string): string;
};

type RuntimeFactory = (options?: RuntimeFactoryOptions) => Promise<PdfCoreEmscriptenModule>;

type RuntimeEsModule = {
  default?: RuntimeFactory;
  PDF_CORE_BUILD_ID?: string;
};

export async function loadPdfCoreBinding(): Promise<WasmCoreBinding> {
  const env = (typeof import.meta !== 'undefined' && (import.meta as unknown as Record<string, unknown>).env) as Record<string, string | undefined> | undefined;
  const runtimeSetting = env?.VITE_PDF_CORE_RUNTIME_URL ?? DEFAULT_RUNTIME_URL;
  const runtimeUrl = sameOriginUrl(runtimeSetting, 'PDF core runtime');
  const wasmUrl = sameOriginUrl(
    env?.VITE_PDF_CORE_WASM_URL ?? new URL('./pdf-core-runtime.wasm', runtimeUrl).href,
    'PDF core WebAssembly',
  );

  let runtimeModule: RuntimeEsModule;
  try {
    runtimeModule = await import(/* @vite-ignore */ runtimeUrl.href) as RuntimeEsModule;
  } catch {
    throw new EngineError(
      'CORE_UNAVAILABLE',
      `Unable to load ${runtimeUrl.pathname}; the browser PDF core runtime is not deployed.`,
    );
  }
  if (typeof runtimeModule.default !== 'function') {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core runtime does not export its Emscripten module factory');
  }

  let module: PdfCoreEmscriptenModule;
  try {
    module = await runtimeModule.default({
      locateFile(path) {
        return path.endsWith('.wasm') ? wasmUrl.href : new URL(path, runtimeUrl).href;
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new EngineError('CORE_UNAVAILABLE', `Unable to initialize the PDF core runtime${detail}`);
  }

  return createPdfCoreBinding(module, { coreBuildId: runtimeModule.PDF_CORE_BUILD_ID });
}

function sameOriginUrl(value: string, label: string): URL {
  const url = new URL(value, globalThis.location.href);
  if (url.origin !== globalThis.location.origin) {
    throw new EngineError('INVALID_REQUEST', `${label} must be loaded from the application origin`);
  }
  return url;
}
