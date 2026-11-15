import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../js/live.js';

function dom(t) {
  const original = new Map(['Node', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Element {
    constructor(text = '') { this.text = text; this.attributes = {}; this.children = []; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(node) { this.children.push(node); }
  }
  globalThis.Node = Element;
  globalThis.document = { baseURI: 'https://workstation.example/', createElement: () => new Element(), createTextNode: text => new Element(text) };
  t.after(() => { for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
}

test('provider links cannot introduce executable URL schemes', t => {
  dom(t);
  for (const href of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:bad']) {
    assert.equal(h('a', { href }, 'Provider').attributes.href, undefined);
  }
  for (const href of ['https://science.nasa.gov/example', '/api/events', '#/signin']) {
    assert.equal(h('a', { href }, 'Provider').attributes.href, href);
  }
});

test('provider strings remain text and image URLs retain only safe formats', t => {
  dom(t);
  const label = '<img src=x onerror=alert(1)>';
  assert.equal(h('p', null, label).children[0].text, label);
  assert.equal(h('img', { src: 'javascript:alert(1)' }).attributes.src, undefined);
  for (const src of ['https://images.nasa.gov/photo.jpg', 'blob:preview', 'data:image/png;base64,aGVsbG8=']) {
    assert.equal(h('img', { src }).attributes.src, src);
  }
});
