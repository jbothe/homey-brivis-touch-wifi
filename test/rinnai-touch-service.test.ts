'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RinnaiTouchService = require('../lib/rinnai/RinnaiTouchService');

// The service turns the module's reverse engineered status payload into the
// values the capabilities show, and turns capability writes back into protocol
// commands. It is the layer where a misreading is invisible - nothing throws,
// the app just reports something that isn't true - so these tests pin the
// readings that are easy to get wrong and the commands that go on the wire.

function makeLogger() {
  return {
    debug() {}, info() {}, warn() {}, error() {},
  };
}

interface SetRequest { type: string; path: string; state: string }

/**
 * Stands in for RinnaiTouchRepository: hands back a fixed status payload and
 * records the commands the service tries to send.
 */
class FakeRepository extends EventEmitter {

  public sent: SetRequest[] = [];

  constructor(public status: unknown[]) {
    super();
  }

  async execute(request: { type: string }): Promise<unknown> {
    if (request.type === 'get') {
      return this.status;
    }
    if (request.type === 'set') {
      this.sent.push(request as SetRequest);
    }
    return undefined;
  }

}

/**
 * A multi-setpoint heat/cool payload with two installed zones. `st` is the
 * tri-state {mode}.OOP.ST field the on/off and fan capabilities share.
 */
function heatStatus(st: string) {
  return [
    {
      SYST: {
        CFG: {
          MTSP: 'Y', TU: 'C', ZA: 'Living', ZB: '  ', ZC: '', ZD: '',
        },
        AVM: { HG: 'Y', CG: 'Y', EC: 'N' },
        OSS: { MD: 'H' },
      },
    },
    {
      HGOM: {
        CFG: {
          ZAIS: 'Y', ZBIS: 'Y', ZCIS: 'N', ZDIS: 'N',
        },
        OOP: { ST: st, FL: '05' },
        GSS: { HC: 'Y' },
        ZAO: {
          OP: 'M', SP: '21', AO: 'N', UE: 'Y',
        },
        ZBO: {
          OP: 'M', SP: '19', AO: 'N', UE: 'N',
        },
        ZAS: { MT: '205', AE: 'Y', AT: 'W' },
        ZBS: { MT: '198', AE: 'N', AT: 'S' },
      },
    },
  ];
}

/** An evap payload, in Manual. `sp` is the raw comfort level (19 coolest - 34 warmest). */
function evapStatus(sp: string) {
  return [
    {
      SYST: {
        CFG: {
          MTSP: 'Y', TU: 'C', ZA: 'Living', ZB: 'Beds', ZC: '', ZD: '',
        },
        AVM: { HG: 'N', CG: 'N', EC: 'Y' },
        OSS: { MD: 'E' },
      },
    },
    {
      ECOM: {
        CFG: { ZAIS: 'Y', ZBIS: 'Y' },
        GSO: {
          SW: 'N', FS: 'N', FL: '08', OP: 'M', SP: sp, PS: 'N', ZAUE: 'Y', ZBUE: 'N',
        },
        GSS: {
          BY: 'Y', MT: '230', ZAAE: 'Y', ZBAE: 'N',
        },
      },
    },
  ];
}

async function startService(status: unknown[]) {
  const repository = new FakeRepository(status);
  const service = new RinnaiTouchService(makeLogger(), repository);
  await service.init();
  return { service, repository };
}

//
// The tri-state field behind onoff and onoff.fan
//
// In heat/cool, State and FanState are two readings of one protocol field:
// 'N' heating/cooling, 'Z' fan only, 'F' off. Reading State as (=== 'N') made
// fan-only display as a powered-off device, and made the two capabilities
// behave as hidden radio buttons.

test('heating reads as running with the fan off', async () => {
  const { service } = await startService(heatStatus('N'));

  assert.equal(service.getState(), true);
  assert.equal(service.getFanState(), false);
});

test('fan-only reads as running, not as switched off', async () => {
  const { service } = await startService(heatStatus('Z'));

  assert.equal(service.getState(), true, 'the unit is blowing air - it is not off');
  assert.equal(service.getFanState(), true);
});

test('off reads as off with the fan off', async () => {
  const { service } = await startService(heatStatus('F'));

  assert.equal(service.getState(), false);
  assert.equal(service.getFanState(), false);
});

test('turning the fan off in heat/cool returns to heating rather than shutting down', async () => {
  // Both capabilities write the same field, so 'off' here would be a second
  // power switch with no way back to heating.
  const { service, repository } = await startService(heatStatus('Z'));

  await service.setFanState(false);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['HGOM.OOP.ST', 'N']]);
});

test('turning the fan on in heat/cool switches to fan-only', async () => {
  const { service, repository } = await startService(heatStatus('N'));

  await service.setFanState(true);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['HGOM.OOP.ST', 'Z']]);
});

test('switching off from fan-only still sends off', async () => {
  const { service, repository } = await startService(heatStatus('Z'));

  await service.setState(false);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['HGOM.OOP.ST', 'F']]);
});

test('evap keeps its own separate fan field', async () => {
  // Evap really does have two independent controls (GSO.SW and GSO.FS), so the
  // heat/cool special case must not leak into it.
  const { service, repository } = await startService(evapStatus('25'));

  await service.setFanState(false);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['ECOM.GSO.FS', 'F']]);
});

//
// Evap setpoints
//
// Manual has none - just zone on/off, fan speed and pump - and the module
// rejects writes to GSO.SP there. Auto holds a comfort level, which the
// Networker shows as 1 (warmest) - 16 (coolest) and the module stores
// inverted, as 34 - 19.

/** evapStatus with GSO.OP set: 'A' Auto, 'M' Manual. */
function evapWithControl(op: 'A' | 'M', sp: string) {
  const status = evapStatus(sp);
  (status[1] as { ECOM: { GSO: Record<string, string> } }).ECOM.GSO.OP = op;
  return status;
}

test('evap reports no target temperature', async () => {
  const { service } = await startService(evapWithControl('A', '25'));

  assert.equal(service.getTargetTemperature('A'), undefined);
  assert.equal(service.getTargetTemperature('U'), undefined);
});

test('setting a target temperature in evap fails without sending anything', async () => {
  const { service, repository } = await startService(evapWithControl('A', '25'));

  await assert.rejects(() => service.setTargetTemperature(16, 'A'), /no target temperature/);
  assert.deepEqual(repository.sent, []);
});

test('evap Auto reports the comfort level as the Networker shows it', async () => {
  // Both ends confirmed on a real unit: coolest is raw 19, warmest raw 34.
  const coolest = await startService(evapWithControl('A', '19'));
  const warmest = await startService(evapWithControl('A', '34'));

  assert.equal(coolest.service.isEvapAuto, true);
  assert.equal(coolest.service.getComfortLevel(), 16);
  assert.equal(warmest.service.getComfortLevel(), 1);
});

test('a comfort level is sent as the raw value the module stores', async () => {
  const { service, repository } = await startService(evapWithControl('A', '25'));

  await service.setComfortLevel(16);
  await service.setComfortLevel(1);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]),
    [['ECOM.GSO.SP', '19'], ['ECOM.GSO.SP', '34']]);
});

test('evap Manual has no comfort level and refuses to set one', async () => {
  // The 11:26 failure: SP 24 sent in Manual, three timeouts, then rejected.
  const { service, repository } = await startService(evapWithControl('M', '24'));

  assert.equal(service.getComfortLevel(), undefined);
  await assert.rejects(() => service.setComfortLevel(6), /in Auto/);
  assert.deepEqual(repository.sent, []);
});

test('out-of-range comfort levels are refused', async () => {
  const { service, repository } = await startService(evapWithControl('A', '25'));

  await assert.rejects(() => service.setComfortLevel(0), /1 to 16/);
  await assert.rejects(() => service.setComfortLevel(17), /1 to 16/);
  assert.deepEqual(repository.sent, []);
});

test('evap control switches between Auto and Manual', async () => {
  const { service, repository } = await startService(evapWithControl('M', '25'));

  assert.equal(service.getEvapControlMode(), service.ControlModes.MANUAL);
  await service.setEvapControlMode(service.ControlModes.SCHEDULE);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['ECOM.GSO.OP', 'A']]);
});

test('evap control is undefined, and cannot be set, outside evap', async () => {
  const { service, repository } = await startService(heatStatus('N'));

  assert.equal(service.getEvapControlMode(), undefined);
  assert.equal(service.getComfortLevel(), undefined);
  await assert.rejects(() => service.setEvapControlMode(service.ControlModes.SCHEDULE));
  assert.deepEqual(repository.sent, []);
});

/** A real evap Auto frame, captured with the fan and pump running. */
function evapAutoRunningStatus() {
  return [
    {
      SYST: {
        CFG: {
          MTSP: 'Y', TU: 'C', ZA: 'Living', ZB: 'Beds', ZC: '', ZD: '',
        },
        AVM: { HG: 'N', CG: 'N', EC: 'Y' },
        OSS: { MD: 'E' },
      },
    },
    {
      ECOM: {
        CFG: {
          ZUIS: 'N', ZAIS: 'Y', ZBIS: 'Y', ZCIS: 'N', ZDIS: 'N', TP: 'N',
        },
        GSO: {
          SW: 'N', OP: 'A', SP: '21', ZUUE: 'N', ZAUE: 'Y', ZBUE: 'N', ZCUE: 'N', ZDUE: 'N',
        },
        GSS: {
          PW: 'N', BY: 'N', PO: 'Y', FO: 'Y', SN: 'N', MT: '234', ZUAE: 'N', ZAAE: 'Y', ZBAE: 'Y', ZCAE: 'N', ZDAE: 'N',
        },
        PSU: { AV: 'N', SFE: 'N' },
      },
    },
  ];
}

test('evap Auto reads the running fan and pump, since GSO no longer carries them', async () => {
  const { service } = await startService(evapAutoRunningStatus());

  assert.equal(service.isEvapAuto, true);
  assert.equal(service.getComfortLevel(), 14);
  assert.equal(service.getPreWet(), false);
  assert.equal(service.getFanState(), true, 'GSS.FO: the fan is running');
  assert.equal(service.getPumpState(), true, 'GSS.PO: the pump is running');
  assert.ok(Number.isNaN(service.getFanSpeed()), 'Auto does not report a fan speed');
});

test('pre-wet reads from GSS.PW, with the pump on and the fan not yet', async () => {
  // Captured on a real unit just after picking the coolest level in Auto.
  const status = evapAutoRunningStatus();
  const gss = (status[1] as { ECOM: { GSS: Record<string, string> } }).ECOM.GSS;
  Object.assign(gss, { PW: 'Y', PO: 'Y', FO: 'N' });
  const { service } = await startService(status);

  assert.equal(service.getPreWet(), true);
  assert.equal(service.getPumpState(), true);
  assert.equal(service.getFanState(), false);
});

test('pre-wet is undefined outside evap', async () => {
  const { service } = await startService(heatStatus('N'));

  assert.equal(service.getPreWet(), undefined);
});

test('evap Manual still reads the fan and pump settings', async () => {
  // evapStatus has FS N and PS N in GSO and no FO/PO in GSS.
  const { service } = await startService(evapWithControl('M', '25'));

  assert.equal(service.getFanState(), true);
  assert.equal(service.getPumpState(), true);
});

test('in evap Auto the fan, fan speed and pump are refused, since the Networker runs them', async () => {
  const { service, repository } = await startService(evapWithControl('A', '25'));

  await assert.rejects(() => service.setFanState(false), /Auto/);
  await assert.rejects(() => service.setFanSpeed(10), /Auto/);
  await assert.rejects(() => service.setPumpState(true), /Auto/);
  assert.deepEqual(repository.sent, []);
});

test('in evap Manual the fan speed and pump are sent', async () => {
  const { service, repository } = await startService(evapWithControl('M', '25'));

  await service.setFanSpeed(10);
  await service.setPumpState(false);

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]),
    [['ECOM.GSO.FL', '10'], ['ECOM.GSO.PS', 'F']]);
});

test('heat/cool setpoints are sent as plain degrees', async () => {
  const { service, repository } = await startService(heatStatus('N'));

  await service.setTargetTemperature(23, 'A');

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['HGOM.ZAO.SP', '23']]);
});

test('a setpoint equal to the current one sends nothing', async () => {
  const { service, repository } = await startService(heatStatus('N'));

  await service.setTargetTemperature(21, 'A');

  assert.deepEqual(repository.sent, []);
});

//
// Zone discovery
//

test('init lists only installed zones as controllers', async () => {
  const { service } = await startService(heatStatus('N'));

  assert.deepEqual(service.controllers, ['A', 'B']);
});

test('re-running init rebuilds the controller list instead of appending to it', async () => {
  // init() is retried after a failed connect. Appending duplicated every zone,
  // which then pairs duplicate devices.
  const { service } = await startService(heatStatus('N'));

  await service.init();
  await service.init();

  assert.deepEqual(service.controllers, ['A', 'B']);
});

test('a blank zone name falls back to its letter', async () => {
  const { service } = await startService(heatStatus('N'));

  assert.equal(service.getZoneName('A'), 'Living');
  assert.equal(service.getZoneName('B'), 'Zone B', 'whitespace-only names are not useful labels');
});

//
// Single-setpoint systems
//

test('a single-setpoint system reports one common controller', async () => {
  const status = heatStatus('N');
  (status[0] as { SYST: { CFG: { MTSP: string } } }).SYST.CFG.MTSP = 'N';
  const { service } = await startService(status);

  assert.equal(service.hasMultiSetPoint, false);
  assert.deepEqual(service.controllers, ['U']);
});

test('active status falls back to the unit-wide flag without multi-setpoint', async () => {
  // AutoEnabled resolves to a per-zone path that does not exist on this
  // hardware, so reading it directly left the capability permanently false.
  const status = heatStatus('N');
  (status[0] as { SYST: { CFG: { MTSP: string } } }).SYST.CFG.MTSP = 'N';
  const { service } = await startService(status);

  assert.equal(service.getAutoEnabled('U'), false, 'the per-zone path is absent here');
  assert.equal(service.getSystemActive('U'), true, 'but GSS.HC says it is running');
});

test('multi-setpoint active status stays per zone', async () => {
  const { service } = await startService(heatStatus('N'));

  assert.equal(service.getSystemActive('A'), true);
  assert.equal(service.getSystemActive('B'), false);
});

/** A real evap Manual frame, fan and pump stopped. Tweak GSO/GSS per test. */
function evapManualStatus(gso: Record<string, string> = {}, gss: Record<string, string> = {}) {
  const status = [
    {
      SYST: {
        CFG: {
          MTSP: 'Y', TU: 'C', ZA: 'Living', ZB: 'Beds', ZC: '', ZD: '',
        },
        AVM: { HG: 'N', CG: 'N', EC: 'Y' },
        OSS: { MD: 'E' },
      },
    },
    {
      ECOM: {
        CFG: {
          ZUIS: 'N', ZAIS: 'Y', ZBIS: 'Y', ZCIS: 'N', ZDIS: 'N', TP: 'N',
        },
        GSO: {
          SW: 'N', OP: 'M', FS: 'F', PS: 'F', FL: '04', ZUUE: 'N', ZAUE: 'Y', ZBUE: 'N', ZCUE: 'N', ZDUE: 'N',
        },
        GSS: {
          PW: 'N', BY: 'N', PO: 'N', FO: 'N', SN: 'N', MT: '234', ZUAE: 'N', ZAAE: 'Y', ZBAE: 'Y', ZCAE: 'N', ZDAE: 'N',
        },
        PSU: { AV: 'N', SFE: 'N' },
      },
    },
  ];
  const { ECOM } = status[1] as { ECOM: { GSO: Record<string, string>, GSS: Record<string, string> } };
  Object.assign(ECOM.GSO, gso);
  Object.assign(ECOM.GSS, gss);
  return status;
}

test('a switched-off evap zone is not active, though the module flags it so', async () => {
  // Seen on a real unit with one of two zones on: ZBUE N but ZBAE Y.
  const { service } = await startService(evapManualStatus({ FS: 'N' }, { FO: 'Y' }));

  assert.equal(service.getAutoEnabled('B'), true, 'the raw flag is set');
  assert.equal(service.getSystemActive('A'), true);
  assert.equal(service.getSystemActive('B'), false, 'but zone B is switched off');
});

test('an evap zone with the fan and pump stopped is not active, though AE says so', async () => {
  // Manual, everything stopped: ZAAE still Y, and BY is N whatever happens.
  const { service } = await startService(evapManualStatus());

  assert.equal(service.getAutoEnabled('A'), true, 'the raw flag is set');
  assert.equal(service.getSystemActive('A'), false, 'but nothing is running');
});

test('an evap zone is active with only the pump running, as in pre-wet', async () => {
  const { service } = await startService(evapManualStatus({}, { PO: 'Y', PW: 'Y' }));

  assert.equal(service.getSystemActive('A'), true);
});

test('single-setpoint evap is active while the cooler runs, though BY reads N', async () => {
  const status = evapManualStatus({ FS: 'N' }, { FO: 'Y' });
  (status[0] as { SYST: { CFG: { MTSP: string } } }).SYST.CFG.MTSP = 'N';
  const { service } = await startService(status);

  assert.equal(service.getSystemActive('U'), true);
});

test('Manual pre-wet shows the fan as set, though the module holds it off', async () => {
  // From a real unit, just after turning the pump on in Manual: FS N but FO N
  // while PW is Y. The fan is the user's control in Manual, so it shows what
  // they set rather than flipping off by itself; pre-wet explains the still air.
  const { service } = await startService(evapManualStatus({ FS: 'N', PS: 'N' }, { PW: 'Y', PO: 'Y' }));

  assert.equal(service.getFanState(), true);
  assert.equal(service.getPumpState(), true);
  assert.equal(service.getPreWet(), true);
  assert.equal(service.getSystemActive('A'), true);
});

test('evap Manual reads the fan and pump settings, which agree with what runs', async () => {
  // Fan-only, from a real unit: FS N with FO Y, PS F with PO N.
  const { service } = await startService(evapManualStatus({ FS: 'N' }, { FO: 'Y' }));

  assert.equal(service.isEvapAuto, false);
  assert.equal(service.getFanState(), true);
  assert.equal(service.getPumpState(), false);
  assert.equal(service.getFanSpeed(), 4);
  assert.equal(service.getComfortLevel(), undefined);
});

//
// Schedule period
//
// Read-only, and the one path in the table with no prior code behind it. The
// single letter codes are inferred from the path table's comment rather than
// observed, so the unknown-value path matters as much as the happy one.

test('schedule period reads per zone', async () => {
  const { service } = await startService(heatStatus('N'));

  assert.equal(service.getSchedulePeriod('A'), service.SchedulePeriods.WAKE);
  assert.equal(service.getSchedulePeriod('B'), service.SchedulePeriods.SLEEP);
});

test('an unrecognised schedule period is left unset rather than guessed', async () => {
  const status = heatStatus('N');
  (status[1] as { HGOM: { ZAS: { AT: string } } }).HGOM.ZAS.AT = 'X';
  const { service } = await startService(status);

  assert.equal(service.getSchedulePeriod('A'), undefined);
  assert.equal(service.getSchedulePeriod('B'), service.SchedulePeriods.SLEEP,
    'one bad code does not discard the others');
});

test('evap reports no schedule period, since the protocol has no path for it', async () => {
  const { service } = await startService(evapStatus('24'));

  assert.equal(service.getSchedulePeriod('A'), undefined);
});

//
// Frames missing the mode group
//
// The module has been seen sending SYST on its own. That frame reached
// StateService.getState() through the socket's 'data' callback and threw on
// Object.keys(undefined), which took the app down.

test('a status frame with only SYST keeps the last full state', async () => {
  const { service, repository } = await startService(heatStatus('N'));

  assert.doesNotThrow(() => repository.emit('status', [heatStatus('F')[0]]));

  assert.equal(service.getState(), true, 'the SYST-only frame must not blank the state');
  assert.deepEqual(service.zones, ['A', 'B']);
});

test('a status frame the service cannot parse is discarded rather than thrown', async () => {
  const { service, repository } = await startService(heatStatus('N'));
  const status = heatStatus('F');
  status[0].SYST!.OSS.MD = 'X';

  assert.doesNotThrow(() => repository.emit('status', status));

  assert.equal(service.getState(), true);
});
