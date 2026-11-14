import { describe, expect, it } from 'vitest';
import main, { app, IngestWorkflow, ReplayRoom } from '../../main.js';
import worker from '../worker.js';

describe('backend/main.js entry point', () => {
  it('re-exports the Worker handlers', () => {
    expect(main).toBe(worker);
    expect(typeof main.fetch).toBe('function');
    expect(typeof main.queue).toBe('function');
    expect(typeof main.scheduled).toBe('function');
    expect(typeof app.fetch).toBe('function');
  });

  it('exports the Workflow and Durable Object classes Cloudflare requires', () => {
    expect(typeof IngestWorkflow).toBe('function');
    expect(typeof ReplayRoom).toBe('function');
  });
});
