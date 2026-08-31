'use strict';

import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
// A real import, not require(): this one is TypeScript with a named export,
// unlike the vendored .js files the other suites reach for.
import { RinnaiConnection } from '../lib/rinnai/RinnaiConnection';

// The command path end to end, against a module that speaks the real protocol.
// Everything below RinnaiConnection now propagates errors instead of logging
// them, so these pin both halves of that: a command that lands still lands, and
// one that cannot be built fails with the reason rather than a stray TypeError
// from reading state that was never populated.

/**
 * Stands in for a multi-setpoint heat installation with zones A and B - the
 * shape the app is actually deployed against. Streams status frames the way the
 * module does (roughly continuously) and applies writes it receives, so command
 * confirmation goes through the same path as on real hardware.
 */
async function startFakeModule() {
  const state: Record<string, Record<string, Record<string, string>>> = {
    SYST: {
      CFG: {
        // Unnamed zones come back space-padded rather than empty: StateService
        // treats a falsy value as absent, and init() calls .trim() on whatever
        // it gets, so '' would read as a missing field.
        MTSP: 'Y', TU: 'C', ZA: 'Zone A', ZB: 'Zone B', ZC: '    ', ZD: '    ',
      },
      AVM: { HG: 'Y', CG: 'N', EC: 'N' },
      OSS: { MD: 'H' },
    },
    HGOM: {
      CFG: {
        ZAIS: 'Y', ZBIS: 'Y', ZCIS: 'N', ZDIS: 'N',
      },
      OOP: { ST: 'N', FL: '00' },
      ZAO: { SP: '21', OP: 'M', AO: 'O' },
      ZBO: { SP: '16', OP: 'M', AO: 'N' },
      ZAS: { MT: '216', AE: 'Y' },
      ZBS: { MT: '222', AE: 'N' },
    },
  };

  let sequence = 0;
  const frame = () => {
    sequence = (sequence + 1) % 255;
    const payload = JSON.stringify([{ SYST: state.SYST }, { HGOM: state.HGOM }]);
    return `N${String(sequence).padStart(6, '0')}${payload}`;
  };

  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const stream = setInterval(() => socket.write(frame()), 150);
    socket.on('close', () => clearInterval(stream));
    socket.on('error', () => clearInterval(stream));

    // A write looks like N{6 digit seq}{"HGOM":{"ZAO":{"SP":"24"}}} - apply it
    // so the next frame reflects it, which is how the app confirms commands.
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      const body = JSON.parse(text.substr(7));
      const group1 = Object.keys(body)[0];
      const group2 = Object.keys(body[group1])[0];
      const field = Object.keys(body[group1][group2])[0];
      state[group1][group2][field] = body[group1][group2][field];
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    read: (g1: string, g2: string, f: string) => state[g1][g2][f],
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function connect(port: number, lines: string[] = []) {
  return new RinnaiConnection((...args: unknown[]) => lines.push(args.join(' ')), {
    address: '127.0.0.1',
    port,
    closeConnectionDelay: 20,
    connectTimeout: 3000,
  });
}

test('a command reaches the module and is confirmed from its status stream', async () => {
  const module_ = await startFakeModule();
  const rinnai = connect(module_.port);

  try {
    await rinnai.init();

    assert.equal(rinnai.mode, 'heat');
    assert.equal(rinnai.getTargetTemperature('A'), 21);
    assert.equal(rinnai.getZoneName('A'), 'Zone A');

    await rinnai.setTargetTemperature(24, 'A');

    assert.equal(module_.read('HGOM', 'ZAO', 'SP'), '24',
      'the module should have received the write');
    assert.equal(rinnai.getTargetTemperature('A'), 24);
  } finally {
    await rinnai.close();
    await module_.close();
  }
});

test('a command with no status behind it reports that, not a TypeError', async () => {
  // Nothing listening, so no status frame has ever arrived. Every setter checks
  // the current value before writing, and those checks read state maps that are
  // only populated by a status read - unguarded they threw
  // "Cannot read properties of undefined", which told nobody anything.
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const lines: string[] = [];
  const rinnai = connect(port, lines);

  await assert.rejects(
    () => rinnai.setTargetTemperature(24, 'A'),
    /No status has been read from the module yet/,
  );

  // And it must not have put a half-built command on the wire. The sequence
  // number and mode both come off the last frame, so with neither the command
  // serialised to N000NaN{"undefined":...}.
  const sent = lines.filter((line) => line.includes('Sending Command'));
  assert.deepEqual(sent, [], 'nothing should be sent without a status to build from');
});

test('a failed command is reported once, not once per layer', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const lines: string[] = [];
  const rinnai = connect(port, lines);

  await assert.rejects(() => rinnai.setTargetTemperature(24, 'A'));

  // The service used to log-and-rethrow in both sendRequest() and the setter,
  // on top of the repository doing the same twice below it. The rejection is
  // the report; the outermost caller (device.ts / driver.ts) logs it once.
  const errors = lines.filter((line) => line.startsWith('[error]'));
  assert.deepEqual(errors, [], 'nothing on this path should log an error itself');

  // The one line it does emit is the swallowed pre-read, which is a real and
  // separate event - the read failed before the command was even attempted.
  const reads = lines.filter((line) => line.includes('Status read failed'));
  assert.equal(reads.length, 1);
});

test('refresh() reports a module that has stopped answering', async () => {
  // The service swallows its own read errors, so a poll that quietly failed and
  // one where nothing changed look identical from below. refresh() tells them
  // apart by checking a frame actually arrived - without which a module offline
  // for hours keeps serving its last values as if live.
  const module_ = await startFakeModule();
  const rinnai = connect(module_.port);

  try {
    await rinnai.init();
    await rinnai.refresh();

    await module_.close();
    // The repository serves a status less than a second old straight from
    // cache, which would answer the next refresh without ever touching the
    // socket. Wait that window out so the read is a real one.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await assert.rejects(() => rinnai.refresh(), /No status received/);
  } finally {
    await rinnai.close();
    await module_.close();
  }
});

test('repeated init() leaves the zone list and the connection intact', async () => {
  // Both app.onInit() and the pairing flow call init(), so it has to be safe to
  // call more than once - it must not re-register the status listener or append
  // to the controller list a second time.
  const module_ = await startFakeModule();
  const rinnai = connect(module_.port);

  try {
    await rinnai.init();
    await rinnai.init();
    await rinnai.init();

    assert.deepEqual(rinnai.controllers, ['A', 'B']);
    await rinnai.refresh();
    assert.equal(rinnai.getTargetTemperature('A'), 21);
  } finally {
    await rinnai.close();
    await module_.close();
  }
});

test('a command the module cannot report back is sent once and accepted, not retried', async () => {
  // With the system off the module stops sending the ZxO zone operation blocks
  // entirely, so a setpoint write has no field to confirm against.
  // commandSucceeded() gives up on a missing group, which made all three
  // attempts certain to fail: 30 sec of blocked queue and held connection for a
  // command that could never have been verified.
  //
  // Confirmed against real hardware: writing SP=24 with the system off and then
  // switching it on brings back ZAO.SP=24. The write lands; only the
  // confirmation is missing. Failing here reverted the capability away from a
  // value the module had taken.
  const state: Record<string, Record<string, Record<string, string>>> = {
    SYST: {
      CFG: {
        MTSP: 'Y', TU: 'C', ZA: 'Zone A', ZB: 'Zone B', ZC: '    ', ZD: '    ',
      },
      AVM: { HG: 'Y', CG: 'N', EC: 'N' },
      OSS: { MD: 'H' },
    },
    // Powered off: OOP and the ZxS status blocks only - no ZAO/ZBO.
    HGOM: {
      CFG: {
        ZAIS: 'Y', ZBIS: 'Y', ZCIS: 'N', ZDIS: 'N',
      },
      OOP: { ST: 'F', FL: '00' },
      ZAS: { AE: 'N', MT: '200' },
      ZBS: { AE: 'N', MT: '199' },
    },
  };

  let sequence = 0;
  const frame = () => {
    sequence = (sequence + 1) % 255;
    return `N${String(sequence).padStart(6, '0')}${JSON.stringify([{ SYST: state.SYST }, { HGOM: state.HGOM }])}`;
  };

  const sockets: net.Socket[] = [];
  const received: string[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const stream = setInterval(() => socket.write(frame()), 150);
    socket.on('close', () => clearInterval(stream));
    socket.on('error', () => clearInterval(stream));
    socket.on('data', (chunk) => received.push(chunk.toString()));
    socket.write(frame());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  const lines: string[] = [];
  const rinnai = connect(port, lines);

  try {
    await rinnai.init();
    assert.equal(rinnai.isOn, false, 'fixture is a powered-off system');

    const started = Date.now();
    await rinnai.setTargetTemperature(24, 'A');
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5000, `should not sit through the retries, took ${elapsed}ms`);
    assert.equal(received.length, 1, 'the command should be sent exactly once, not retried');
    assert.match(received[0], /"ZAO":\{"SP":"24"\}/);

    // Accepted, but the log has to say it went out unverified - this is the one
    // path where a resolved command is not proof the module took it.
    const warned = lines.filter((line) => line.includes('unconfirmed'));
    assert.equal(warned.length, 1, `expected one unconfirmed warning, got ${JSON.stringify(lines)}`);
  } finally {
    await rinnai.close();
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
