import type { EngineAdapter } from '@pdf-editor/contracts';

export type RenderPriority = 'active' | 'page' | 'thumbnail';
export type RenderWorkOptions = { signal?: AbortSignal; priority?: RenderPriority };
type Job = { priority: number; run(): Promise<unknown>; finish(value: unknown, failed: boolean): void };
type Lane = { running: boolean; scheduled: boolean; pending: Job[]; paused: Set<object> };
const lanes = new WeakMap<object, Lane>();
const priorities = { active: 0, page: 1, thumbnail: 2 };

function laneFor(engine: object): Lane {
  let lane = lanes.get(engine);
  if (!lane) { lane = { running: false, scheduled: false, pending: [], paused: new Set() }; lanes.set(engine, lane); }
  return lane;
}

function schedule(lane: Lane) {
  if (lane.scheduled) return;
  lane.scheduled = true;
  queueMicrotask(() => {
    lane.scheduled = false;
    if (lane.running || lane.paused.size || !lane.pending.length) return;
    let first = 0;
    for (let index = 1; index < lane.pending.length; index++) {
      if (lane.pending[index]!.priority < lane.pending[first]!.priority) first = index;
    }
    const job = lane.pending.splice(first, 1)[0]!;
    lane.running = true;
    let result: Promise<unknown>;
    try { result = job.run(); } catch (error) { result = Promise.reject(error); }
    void result.then(value => job.finish(value, false), error => job.finish(error, true)).then(() => {
      lane.running = false;
      schedule(lane);
    });
  });
}

/** Display work waits here, before entering the serial native/WASM engine. */
export function renderWork<T>(engine: object, run: () => Promise<T>, options: RenderWorkOptions = {}): Promise<T> {
  const lane = laneFor(engine), { signal } = options;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const job: Job = {
      priority: priorities[options.priority ?? 'active'], run,
      finish(value, failed) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        if (failed) reject(value); else resolve(value as T);
      },
    };
    const cancel = () => {
      const index = lane.pending.indexOf(job);
      if (index >= 0) lane.pending.splice(index, 1);
      job.finish(new DOMException('Rendering cancelled', 'AbortError'), true);
    };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    lane.pending.push(job);
    schedule(lane);
  });
}

export function setRenderWorkPaused(engine: EngineAdapter, owner: object, paused: boolean): void {
  const lane = laneFor(engine);
  if (paused) lane.paused.add(owner); else { lane.paused.delete(owner); schedule(lane); }
}

export function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
