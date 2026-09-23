import type { GatewayLimits } from './config.js';

export type AdmissionFailure = { ok: false; statusCode: 429 | 503; code: string; message: string };
export type AdmissionLease = { ok: true; release(): void };

type IpState = { inFlight: number; starts: number[]; lastSeen: number };

export class AdmissionController {
  private totalInFlight = 0;
  private imageInFlight = 0;
  private readonly ipStates = new Map<string, IpState>();
  private lastSweep = 0;

  constructor(private readonly limits: GatewayLimits) {}

  acquire(ip: string, image: boolean, now = Date.now()): AdmissionFailure | AdmissionLease {
    this.sweep(now);
    const state = this.ipStates.get(ip) ?? { inFlight: 0, starts: [], lastSeen: now };
    state.starts = state.starts.filter(timestamp => timestamp > now - 60_000);
    state.lastSeen = now;

    if (state.starts.length >= this.limits.perIpPerMinute) {
      this.ipStates.set(ip, state);
      return { ok: false, statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests, please try again later' };
    }
    if (state.inFlight >= this.limits.perIpInFlight) {
      this.ipStates.set(ip, state);
      return { ok: false, statusCode: 429, code: 'IP_CONCURRENCY_LIMIT', message: 'Too many concurrent requests from this source' };
    }
    if (this.totalInFlight >= this.limits.inFlight || (image && this.imageInFlight >= this.limits.imageInFlight)) {
      return { ok: false, statusCode: 503, code: 'GATEWAY_BUSY', message: 'AI service is busy, please try again later' };
    }

    this.totalInFlight += 1;
    if (image) this.imageInFlight += 1;
    state.inFlight += 1;
    state.starts.push(now);
    this.ipStates.set(ip, state);

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.totalInFlight -= 1;
        if (image) this.imageInFlight -= 1;
        const current = this.ipStates.get(ip);
        if (current) {
          current.inFlight = Math.max(0, current.inFlight - 1);
          current.lastSeen = Date.now();
        }
      },
    };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.ipStates.size < 10_000) return;
    this.lastSweep = now;
    for (const [ip, state] of this.ipStates) {
      state.starts = state.starts.filter(timestamp => timestamp > now - 60_000);
      if (state.inFlight === 0 && state.starts.length === 0 && state.lastSeen < now - 60_000) this.ipStates.delete(ip);
    }
  }
}
