'use strict';

import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RinnaiTouchTcp = require('../lib/rinnai/RinnaiTouchTcp');

// The module accepts one TCP client at a time, so the whole app funnels through
// a single connection and anything that leaves connect() pending blocks every
// request behind it. These tests pin the failure paths: the connection layer
// must always settle, and must tell the repository when a connection dies on
// its own rather than leaving it to write into a dead socket.

function makeLogger() {
  return {
    debug() {}, info() {}, warn() {}, error() {},
  };
}

// A frame as the module sends it: 'N', a six digit sequence number, then the
// status JSON. RinnaiTouchTcp keys off the leading 'N' and the '[' offset.
const STATUS_FRAME = 'N000001[{"SYST":{"CFG":{"MTSP":"Y"}}}]';

/** A stand-in module. `onConnection` decides how it behaves once connected. */
async function startFakeModule(onConnection: (socket: net.Socket) => void) {
  const server = net.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    address: { address: '127.0.0.1', port },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

test('connect() rejects when the module accepts the socket but never sends a frame', async () => {
  // Held open deliberately: without the connect deadline this is the case that
  // hangs until the OS abandons the connect, ~75 sec later.
  const sockets: net.Socket[] = [];
  const module_ = await startFakeModule((socket) => sockets.push(socket));
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 300);

  try {
    await assert.rejects(
      () => tcp.connect(),
      /Timed out connecting/,
    );
  } finally {
    tcp.destroy();
    sockets.forEach((socket) => socket.destroy());
    await module_.close();
  }
});

test('connect() resolves on the first status frame and emits it', async () => {
  const module_ = await startFakeModule((socket) => socket.write(STATUS_FRAME));
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);

  const received: string[] = [];
  tcp.on('data', (data: string) => received.push(data));

  try {
    await tcp.connect();
    assert.deepEqual(received, [STATUS_FRAME]);
  } finally {
    tcp.destroy();
    await module_.close();
  }
});

test('an unsolicited close is reported upwards and leaves no socket to write into', async () => {
  let serverSocket: net.Socket | undefined;
  const module_ = await startFakeModule((socket) => {
    serverSocket = socket;
    socket.write(STATUS_FRAME);
  });
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);

  const closed = new Promise<void>((resolve) => tcp.once('close', resolve));

  try {
    await tcp.connect();

    // The module rebooting, or Wi-Fi dropping out mid-session.
    serverSocket?.destroy();
    await closed;

    // The repository relies on this rejecting rather than throwing on a null
    // socket, so a command issued in the gap fails cleanly.
    await assert.rejects(
      () => tcp.write(STATUS_FRAME),
      /No open connection/,
    );
  } finally {
    tcp.destroy();
    await module_.close();
  }
});

test('a close we asked for is not reported as an unsolicited drop', async () => {
  const module_ = await startFakeModule((socket) => socket.write(STATUS_FRAME));
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);

  let dropped = false;
  tcp.on('close', () => {
    dropped = true;
  });

  try {
    await tcp.connect();
    tcp.destroy();
    // Give any stray close event a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(dropped, false, 'idle-closing must not look like a lost connection');
  } finally {
    await module_.close();
  }
});
