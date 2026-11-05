import type { EngineAdapter } from '@pdf-editor/contracts';

export type RenderPriority = 'interaction' | 'active' | 'page' | 'model' | 'prefetch' | 'thumbnail' | 'background';
export type RenderWorkOptions = { signal?: AbortSignal; priority?: RenderPriority; key?: string; distance?: number };
type Consumer = { finish(value: unknown, failed: boolean): void };
type Job = {
  priority: number; distance: number; key?: string; started: boolean;
  controller: AbortController; consumers: Set<Consumer>;
  run(signal: AbortSignal): Promise<unknown>;
};
type Lane = { running: Job | null; scheduled: boolean; pending: Job[]; shared: Map<string, Job>; paused: Set<object> };
const lanes = new WeakMap<object, Lane>();
const priorities = { interaction: 0, active: 1, page: 2, model: 3, prefetch: 4, thumbnail: 5, background: 6 };

function laneFor(engine: object): Lane {
  let lane = lanes.get(engine);
  if (!lane) {
    lane = { running: null, scheduled: false, pending: [], shared: new Map(), paused: new Set() };
    lanes.set(engine, lane);
  }
  return lane;
}

function forget(lane: Lane, job: Job): void {
  if (job.key !== undefined && lane.shared.get(job.key) === job) lane.shared.delete(job.key);
}

function schedule(lane: Lane) {
  if (lane.scheduled) return;
  lane.scheduled = true;
  queueMicrotask(() => {
    lane.scheduled = false;
    if (lane.running || !lane.pending.length) return;
    let first = -1;
    for (let index = 0; index < lane.pending.length; index++) {
      const candidate = lane.pending[index]!;
      if (lane.paused.size && candidate.priority !== priorities.interaction) continue;
      const current = first < 0 ? undefined : lane.pending[first];
      if (!current || candidate.priority < current.priority ||
          (candidate.priority === current.priority && candidate.distance < current.distance)) first = index;
    }
    if (first < 0) return;
    const job = lane.pending.splice(first, 1)[0]!;
    job.started = true; lane.running = job;
    let result: Promise<unknown>;
    try { result = job.run(job.controller.signal); } catch (error) { result = Promise.reject(error); }
    const finish = (value: unknown, failed: boolean) => {
      forget(lane, job);
      for (const consumer of [...job.consumers]) consumer.finish(value, failed);
      // Aborting a consumer does not release the serial engine before its real reply.
      lane.running = null;
      schedule(lane);
    };
    void result.then(value => finish(value, false), error => finish(error, true));
  });
}

/** Display work is shared and prioritized before entering the serial native/WASM engine. */
export function renderWork<T>(engine: object, run: (signal: AbortSignal) => Promise<T>, options: RenderWorkOptions = {}): Promise<T> {
  const { signal, key } = options;
  if (signal?.aborted) return Promise.reject(new DOMException('Rendering cancelled', 'AbortError'));
  const lane = laneFor(engine), priority = priorities[options.priority ?? 'active'];
  let job = key === undefined ? undefined : lane.shared.get(key);
  if (!job) {
    job = { priority, distance: options.distance ?? Infinity, started: false,
      controller: new AbortController(), consumers: new Set(), run, ...(key === undefined ? {} : { key }) };
    if (key !== undefined) lane.shared.set(key, job);
    lane.pending.push(job);
  } else {
    job.priority = Math.min(job.priority, priority);
    job.distance = Math.min(job.distance, options.distance ?? Infinity);
  }
  const shared = job;
  const result = new Promise<T>((resolve, reject) => {
    let settled = false;
    const consumer: Consumer = {
      finish(value, failed) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        shared.consumers.delete(consumer);
        if (failed) reject(value); else resolve(value as T);
      },
    };
    const cancel = () => {
      consumer.finish(new DOMException('Rendering cancelled', 'AbortError'), true);
      if (shared.consumers.size) return;
      forget(lane, shared);
      shared.controller.abort();
      if (!shared.started) {
        const index = lane.pending.indexOf(shared);
        if (index >= 0) lane.pending.splice(index, 1);
      }
    };
    shared.consumers.add(consumer);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  schedule(lane);
  return result;
}

export function setRenderWorkPaused(engine: EngineAdapter, owner: object, paused: boolean): void {
  const lane = laneFor(engine);
  if (paused) lane.paused.add(owner); else lane.paused.delete(owner);
  schedule(lane);
}

export function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError' ||
    error !== null && typeof error === 'object' && 'code' in error && error.code === 'CANCELLED';
}
