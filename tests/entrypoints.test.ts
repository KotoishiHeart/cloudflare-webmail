import { describe, expect, it, vi } from 'vitest';
import { handleWebRequest } from '../apps/web/src/app.js';
import {
  INGEST_NOT_READY_REASON,
  rejectUnconfiguredInbound,
} from '../apps/ingest/src/email-handler.js';
import { deferUnimplementedInbound } from '../apps/jobs/src/inbound-consumer.js';

describe('safe Stage 1 entrypoints', () => {
  it('exposes only a bounded web health response', async () => {
    const response = handleWebRequest(new Request('https://webmail.example.com/healthz'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, architectureVersion: 1 });
  });

  it('rejects inbound email until durable staging is implemented', () => {
    const setReject = vi.fn();
    expect(rejectUnconfiguredInbound({ setReject })).toBe(INGEST_NOT_READY_REASON);
    expect(setReject).toHaveBeenCalledWith(INGEST_NOT_READY_REASON);
  });

  it('retries Queue messages instead of acknowledging unfinished work', () => {
    const retry = vi.fn();
    const result = deferUnimplementedInbound([{ body: {}, retry }]);
    expect(result).toEqual({ valid: 0, invalid: 1 });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });
});
