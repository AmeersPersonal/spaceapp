# Workstation tests

## Purpose
Offline regression coverage for the workstation API client, map layer contract,
replay synchronization, UI orchestration and production artifact.

## Contents
Native `*.test.js` suites run with Node's built-in test runner. External API
responses, clocks and WebSockets are mocked; tests never contact Cloudflare.

## Interfaces
Run `npm test` from `workstation/`. Browser verification uses an isolated browser
and a local fixture server; production requests are separate explicit checks.

## Status
Hardening regressions are being added before their fixes.
