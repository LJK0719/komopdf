import { attachEngineWorker, type EngineWorkerServerEndpoint } from '@pdf-editor/editor/worker';
import { loadPdfCoreBinding } from './core-binding.js';

const workerEndpoint = globalThis as unknown as EngineWorkerServerEndpoint;
attachEngineWorker(workerEndpoint, loadPdfCoreBinding);
