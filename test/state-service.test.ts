'use strict';

import test from 'node:test';
import assert from 'node:assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StateService = require('../lib/rinnai/StateService');

// Vendored from homebridge-rinnai-touch-plugin (see lib/rinnai/NOTICE.md) with
// no test coverage upstream. This is the reverse-engineered map from named
// states to the module's JSON protocol paths - the highest-risk logic in the
// app, since a wrong path silently reads/writes the wrong field on real
// hardware. These tests pin the path resolution and payload extraction.

function makeLogger() {
  return {
    debug() {}, info() {}, warn() {}, error() {},
  };
}

test('getPath resolves multi-setpoint zone paths using the Z{zone} group', () => {
  const svc = new StateService(makeLogger());
  svc.hasMultiSetPoint = true;

  assert.equal(svc.getPath('TargetTemp', 'HGOM', 'A'), 'HGOM.ZAO.SP');
  assert.equal(svc.getPath('UserEnabled', 'HGOM', 'B'), 'HGOM.ZBO.UE');
  assert.equal(svc.getPath('ControlMode', 'CGOM', 'A'), 'CGOM.ZAO.OP');
});

test('getPath falls back to the shared GS group when not multi-setpoint', () => {
  const svc = new StateService(makeLogger());
  svc.hasMultiSetPoint = false;

  assert.equal(svc.getPath('TargetTemp', 'HGOM', 'U'), 'HGOM.GSO.SP');
});

test('getPath resolves evap paths from the dedicated evap table', () => {
  const svc = new StateService(makeLogger());
  svc.hasMultiSetPoint = true;

  assert.equal(svc.getPath('PumpState', 'ECOM'), 'ECOM.GSO.PS');
  assert.equal(svc.getPath('UserEnabled', 'ECOM', 'A'), 'ECOM.GSO.ZAUE');
  assert.equal(svc.getPath('CurrentTemp', 'ECOM'), 'ECOM.GSS.MT');
});

test('getPath resolves system-wide paths regardless of mode', () => {
  const svc = new StateService(makeLogger());

  assert.equal(svc.getPath('Mode'), 'SYST.OSS.MD');
  assert.equal(svc.getPath('HasMultiSP'), 'SYST.CFG.MTSP');
});

test('getState extracts the value at the resolved path from a status payload', () => {
  const svc = new StateService(makeLogger());
  svc.hasMultiSetPoint = true;

  const status = [
    { SYST: { OSS: { MD: 'H' } } },
    { HGOM: { ZAO: { SP: '21' }, ZAS: { MT: '201' } } },
  ];

  assert.equal(svc.getState('TargetTemp', status, 'A'), '21');
  assert.equal(svc.getState('CurrentTemp', status, 'A'), '201');
});

test('getState returns undefined for a field absent from the payload', () => {
  const svc = new StateService(makeLogger());
  svc.hasMultiSetPoint = true;

  const status = [{ SYST: {} }, { HGOM: {} }];

  assert.equal(svc.getState('TargetTemp', status, 'A'), undefined);
});
