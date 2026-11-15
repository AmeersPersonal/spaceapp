// room.js — shared replay room over the backend's WebSocket (/api/room/:code).
// Synchronises playback state only (event, frame, playing); it never carries
// imagery or data. No DOM. Imports nothing.
//
// Server → client: {type:'state', state:{eventId,layer,frame,playing,speed,updatedAt,version}},
//                  {type:'presence', count}, {type:'pong'}, {type:'error', error}
// Client → server: load {eventId}, play, pause {frame}, seek {frame}, sync, ping

export const ROOM_CODE_RE = /^[A-Za-z0-9]{4,12}$/;

export class RoomClient {
  /**
   * handlers: { onStatus(status, message), onState(state), onPresence(count), onError(message) }
   * status: 'connecting' | 'open' | 'closed' | 'error'
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.ws = null;
    this.code = '';
    this.pingTimer = null;
  }

  get open() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  connect(code) {
    this.close();
    const clean = String(code || '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(clean)) {
      this.emit('onStatus', 'error', 'Room codes are 4–12 letters or digits.');
      return;
    }
    this.code = clean;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${window.location.host}/api/room/${clean}`);
    } catch (err) {
      this.emit('onStatus', 'error', 'Could not open the room connection.');
      return;
    }
    this.ws = ws;
    this.emit('onStatus', 'connecting', '');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.emit('onStatus', 'open', '');
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'state' && msg.state) this.emit('onState', msg.state);
      else if (msg.type === 'presence') this.emit('onPresence', Number(msg.count) || 0);
      else if (msg.type === 'error') this.emit('onError', String(msg.error || 'room error'));
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.emit('onStatus', 'error', 'The room connection failed. Is the backend running?');
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      this.emit('onStatus', 'closed', '');
    };
  }

  send(msg) {
    if (!this.open) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.stopPing();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close(1000, 'leaving');
      } catch {
        /* already closed */
      }
    }
  }

  stopPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  emit(name, ...args) {
    const fn = this.h[name];
    if (typeof fn === 'function') fn(...args);
  }
}
