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

/** An evap payload. `sp` is the raw comfort level (19-34). */
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

test('evap comfort levels survive a decode/encode round trip', async () => {
  // setTargetTemperature() compares encoded values, which is only sound if
  // encode(decode(level)) is the identity across the whole range.
  const { service } = await startService(evapStatus('25'));

  for (let level = 19; level <= 34; level += 1) {
    const temperature = service.decodeTargetTemperature(String(level));
    assert.equal(service.encodeTargetTemperature(temperature), level,
      `comfort level ${level} did not round trip (via ${temperature} degrees)`);
  }
});

test('an evap setpoint that encodes to the current comfort level sends nothing', async () => {
  // 23 temperatures map onto 16 comfort levels, so 10 and 9 both encode to 20.
  // Sending that command changed nothing the module reports, so the repository
  // never saw it confirmed: three attempts, 30 sec holding the serialized
  // queue, then a failure the user could do nothing about.
  const { service, repository } = await startService(evapStatus('20'));

  assert.equal(service.getTargetTemperature('A'), 9, 'comfort 20 presents as 9 degrees');

  await service.setTargetTemperature(10, 'A');

  assert.deepEqual(repository.sent, [], 'no command should reach the module');
});

test('an evap setpoint that encodes to a different comfort level is sent', async () => {
  const { service, repository } = await startService(evapStatus('20'));

  await service.setTargetTemperature(11, 'A');

  assert.deepEqual(repository.sent.map((r) => [r.path, r.state]), [['ECOM.GSO.SP', '21']]);
});

test('evap zones share one setpoint, since the protocol path has no zone in it', async () => {
  const { service } = await startService(evapStatus('20'));

  assert.equal(service.getTargetTemperature('A'), 9);
  assert.equal(service.getTargetTemperature('B'), 9);
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
