// ReplayRoom Durable Object: one instance per room code, keeps shared playback state and fans it
// out to every connected WebSocket. Uses the WebSocket Hibernation API so idle rooms cost nothing.

import { DurableObject } from 'cloudflare:workers';
import { applyMessage, initialState, parseClientMessage } from './sessionManger.js';

const STATE_KEY = 'state';
const EMPTY_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export class ReplayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get(STATE_KEY)) ?? initialState();
    });
    // Answer pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    await this.ctx.storage.deleteAlarm();
    server.send(this.#stateMessage());
    this.#broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const parsed = parseClientMessage(raw);
    if (parsed.error) return ws.send(JSON.stringify({ type: 'error', error: parsed.error }));
    const result = applyMessage(this.state, parsed.msg);
    if (result.error) return ws.send(JSON.stringify({ type: 'error', error: result.error }));
    if (!result.broadcast) {
      return ws.send(parsed.msg.type === 'ping' ? JSON.stringify({ type: 'pong' }) : this.#stateMessage());
    }
    this.state = result.state;
    await this.ctx.storage.put(STATE_KEY, this.state);
    this.#broadcast(this.#stateMessage());
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
    await this.#onLeave(ws);
  }

  async webSocketError(ws) {
    await this.#onLeave(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.state = initialState();
    }
  }

  async #onLeave(closing) {
    const remaining = this.ctx.getWebSockets().filter((s) => s !== closing).length;
    this.#broadcastPresence(remaining, closing);
    if (remaining === 0) await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
  }

  #stateMessage() {
    return JSON.stringify({ type: 'state', state: this.state, serverTime: Date.now() });
  }

  #broadcastPresence(count = this.ctx.getWebSockets().length, exclude) {
    this.#broadcast(JSON.stringify({ type: 'presence', count }), exclude);
  }

  #broadcast(message, exclude) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(message);
      } catch {
        /* socket went away; close handler cleans up */
      }
    }
  }
}
