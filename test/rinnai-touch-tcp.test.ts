'use strict';

import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import type { EventEmitter } from 'node:events';
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

/** Collects frames until `count` have arrived, then resolves. */
function collect(tcp: EventEmitter, count: number) {
  const frames: string[] = [];
  const done = new Promise<string[]>((resolve) => {
    tcp.on('data', (frame: string) => {
      frames.push(frame);
      if (frames.length === count) {
        resolve(frames);
      }
    });
  });
  return { frames, done };
}

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

test('a silent module fails the connect itself rather than asking to be closed', async () => {
  // The repository's only response to 'timeout' is to queue a close, and the
  // queue is serialized behind the request awaiting this connect - so a close
  // emitted here could not run until the connect it was meant to abort had
  // already finished. The connection layer has to settle this one on its own.
  const sockets: net.Socket[] = [];
  const module_ = await startFakeModule((socket) => sockets.push(socket));
  // Idle timeout well inside the deadline, so the deadline cannot be what fires.
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 5000, 200);

  let askedToClose = false;
  tcp.on('timeout', () => {
    askedToClose = true;
  });

  try {
    const started = Date.now();
    await assert.rejects(
      () => tcp.connect(),
      /accepted the connection but sent no status/,
    );

    assert.equal(askedToClose, false,
      "an unsettled connect must not be handed to the repository's blocked queue");
    assert.ok(Date.now() - started < 2000, 'must not wait out the connect deadline');

    // And it must leave nothing behind for the retry to reuse.
    await assert.rejects(() => tcp.write('N000001'), /No open connection/);
  } finally {
    tcp.destroy();
    sockets.forEach((socket) => socket.destroy());
    await module_.close();
  }
});

test('an established connection going quiet is reported upwards, not failed locally', async () => {
  // The other half: once there is a working connection, whether silence means
  // "drop it" or "poke it" depends on the idle-close policy, which only the
  // repository knows.
  const sockets: net.Socket[] = [];
  const module_ = await startFakeModule((socket) => {
    sockets.push(socket);
    socket.write(STATUS_FRAME);
  });
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 5000, 200);

  const timedOut = new Promise<void>((resolve) => tcp.once('timeout', resolve));

  try {
    await tcp.connect();
    // The module stops streaming but holds the socket open.
    await timedOut;

    // Still connected - tearing it down is the repository's decision to make.
    await tcp.write('N000001');
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

// TCP is a byte stream: the module's status payload for a multi-zone system
// runs past one segment, so frames arrive split, and while it streams they also
// arrive coalesced. Reading a chunk as exactly one frame meant a split frame was
// passed on truncated - and JSON.parse on it threw out of a synchronous socket
// callback, taking the app down.

test('a frame split across segments is reassembled, not truncated', async () => {
  const head = STATUS_FRAME.slice(0, 20);
  const tail = STATUS_FRAME.slice(20);

  const module_ = await startFakeModule((socket) => {
    socket.write(head);
    // Far enough apart to guarantee separate 'data' events.
    setTimeout(() => socket.write(tail), 30);
  });
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);
  const received = collect(tcp, 1);

  try {
    await tcp.connect();
    assert.deepEqual(await received.done, [STATUS_FRAME]);
  } finally {
    tcp.destroy();
    await module_.close();
  }
});

test('a chunk carrying several frames emits every one of them', async () => {
  const second = 'N000002[{"SYST":{"CFG":{"MTSP":"N"}}}]';
  const third = 'N000003[{"SYST":{"CFG":{"MTSP":"Y"}}}]';

  const module_ = await startFakeModule((socket) => {
    socket.write(STATUS_FRAME + second + third);
  });
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);
  const received = collect(tcp, 3);

  try {
    await tcp.connect();
    assert.deepEqual(await received.done, [STATUS_FRAME, second, third]);
  } finally {
    tcp.destroy();
    await module_.close();
  }
});

test('a payload containing brackets in a string is framed on depth, not the last bracket', async () => {
  // Zone names are free text, so ']' inside a string is legitimate. Depth
  // counting has to ignore it - and ignore an escaped quote that would
  // otherwise end the string early.
  const awkward = 'N000004[{"SYST":{"CFG":{"ZA":"Kids] \\" [room"}}}]';

  const module_ = await startFakeModule((socket) => socket.write(awkward));
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);
  const received = collect(tcp, 1);

  try {
    await tcp.connect();
    const [frame] = await received.done;
    assert.equal(frame, awkward);
    // The whole point: the repository can parse what it is handed.
    assert.equal(JSON.parse(frame.substr(7))[0].SYST.CFG.ZA, 'Kids] " [room');
  } finally {
    tcp.destroy();
    await module_.close();
  }
});

test('leading garbage is skipped rather than framed', async () => {
  // Reconnecting mid-stream can leave the tail of a frame whose start we never
  // saw. It has to be dropped, and the next real frame still recognised.
  const module_ = await startFakeModule((socket) => {
    socket.write(`}}}]${STATUS_FRAME}`);
  });
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 2000);
  const received = collect(tcp, 1);

  try {
    await tcp.connect();
    assert.deepEqual(await received.done, [STATUS_FRAME]);
  } finally {
    tcp.destroy();
    await module_.close();
  }
});

test('a partial frame alone does not settle the connect', async () => {
  // connect() resolves on the first *complete* frame. Resolving on a partial
  // one would hand the repository a connection it cannot read a status from.
  const module_ = await startFakeModule((socket) => {
    socket.write(STATUS_FRAME.slice(0, 20));
  });
  const tcp = new RinnaiTouchTcp(makeLogger(), module_.address, 5000, 300, 5000);

  try {
    await assert.rejects(() => tcp.connect(), /Timed out connecting/);
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
