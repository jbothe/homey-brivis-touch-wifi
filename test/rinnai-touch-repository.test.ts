'use strict';

import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RinnaiTouchRepository = require('../lib/rinnai/RinnaiTouchRepository');

// These cover the state the app spends its bad days in: the module answers UDP
// discovery but refuses TCP, so every poll runs the full three-attempt connect
// and fails. What matters is that the failure is reported once, with its cause
// intact, and that nothing is left believing the connection is usable.

function makeLogger(lines: string[] = []) {
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`[${level}] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`);
  };
  return {
    debug() {}, info: record('info'), warn: record('warn'), error: record('error'),
  };
}

function makeSettings(address: string, port: number) {
  return {
    address,
    port,
    // Kept short so the tests don't pay the real grace periods.
    closeConnectionDelay: 20,
    idleCloseDelay: 5000,
    connectTimeout: 300,
  };
}

/** A port nothing is listening on, so connects are refused immediately. */
async function findClosedPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('a refused connection fails the request with the underlying reason', async () => {
  const port = await findClosedPort();
  const repository = new RinnaiTouchRepository(makeLogger(), makeSettings('127.0.0.1', port));

  // 'Unable to connect' on its own could not be told apart from a module that
  // was never discovered, or one that accepted the socket and went silent.
  await assert.rejects(
    () => repository.execute({ type: 'get' }),
    /Unable to connect:.*ECONNREF/,
  );
});

test('a failed request is logged once, not once per layer it passes through', async () => {
  const lines: string[] = [];
  const port = await findClosedPort();
  const repository = new RinnaiTouchRepository(makeLogger(lines), makeSettings('127.0.0.1', port));

  await assert.rejects(() => repository.execute({ type: 'get' }));

  // process() and execute() both used to log-and-rethrow the same object, and
  // the service logged it a third time - 3 identical stacks per failed poll,
  // every 15 sec, for as long as the module stayed down.
  const failures = lines.filter((line) => line.includes('Unable to connect'));
  assert.deepEqual(failures, [], 'the rejection is the report; layers must not log it too');

  // The per-attempt warnings are the useful signal, and carry the reason once.
  const attempts = lines.filter((line) => line.includes('Attempt'));
  assert.equal(attempts.length, 3);
  assert.match(attempts[0], /ECONNREF/);
});

test('a connection that never delivers a frame is not treated as fresh', async () => {
  // A module that accepts the socket and says nothing. Before the statusAge()
  // fix the staleness check compared against an undefined timestamp, so the
  // NaN read as "not stale" and the dead connection was never torn down.
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  const repository = new RinnaiTouchRepository(makeLogger(), makeSettings('127.0.0.1', port));

  try {
    await assert.rejects(
      () => repository.execute({ type: 'get' }),
      /Unable to connect|Failed to get new status/,
    );

    assert.equal(repository.lastStatusTimestamp, undefined,
      'no frame arrived, so nothing may report a status time');
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
