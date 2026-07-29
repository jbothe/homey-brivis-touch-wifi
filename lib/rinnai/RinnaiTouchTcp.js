const RinnaiTouchUdp = require('./RinnaiTouchUdp');
const net = require('net');
var EventEmitter = require('events');

// Backstop ceiling on a single connect() attempt, covering UDP discovery, the
// TCP handshake and the module's first status frame. Anything that leaves
// connect() pending blocks the repository's serialised queue behind it.
//
// Most silent failures are now caught sooner by IDLE_TIMEOUT below, which the
// socket applies from the moment it starts connecting - a stale cached address
// that black-holes packets (otherwise ~75 sec for the OS to give up) and a
// module that accepts the socket but never pushes a frame both trip it. This
// deadline remains for what the socket timer cannot see, chiefly a UDP
// discovery that never settles, since there is no socket yet at that point.
//
// Keep this above IDLE_TIMEOUT. Nothing breaks if it is not - the deadline
// still fails and tears down the connect cleanly - but it takes over as the
// path that fires, so silent modules are detected later and reported as a flat
// timeout instead of naming what went wrong.
const DEFAULT_CONNECT_TIMEOUT = 10000;

// Socket-level idle timeout. The module streams roughly a frame a second while
// connected, so this much silence always means something is wrong - but what to
// do about it depends on whether the connect has settled yet, which is why
// connect() below handles the two cases separately rather than reporting both
// upwards. Once established it is the repository's call, since only it knows
// whether it is holding the connection open deliberately.
const IDLE_TIMEOUT = 5000;

class RinnaiTouchTcp extends EventEmitter {
    #log;
    #udp;
    #defaultAddress;
    #address;
    #socket;
    #connectTimeout;
    #idleTimeout;

    constructor(log, address, timeout = 5000, connectTimeout = DEFAULT_CONNECT_TIMEOUT,
        idleTimeout = IDLE_TIMEOUT) {
        super();
        this.#log = log;
        this.#defaultAddress = address;
        this.#connectTimeout = connectTimeout;
        this.#idleTimeout = idleTimeout;
        this.#log.debug(this.constructor.name, undefined, 'log', JSON.stringify(address), timeout);
        this.#udp = new RinnaiTouchUdp(log, timeout);
    }

    connect() {
        this.#log.debug(this.constructor.name, 'connect');

        let self = this;
        return new Promise(async (resolve, reject) => {
            let settled = false;
            // Whether this socket ever carried a status frame. Distinguishes a
            // working connection dying (worth an info line) from a connect that
            // never landed, where the close is just the tail of a failure the
            // repository is already logging with its attempt number.
            let established = false;

            const deadline = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                self.#log.warn(`TCP Connection: No response within ${self.#connectTimeout} ms`);
                self.#discard();
                reject(new Error('Timed out connecting to Rinnai Touch module'));
            }, self.#connectTimeout);

            const succeed = () => {
                established = true;
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(deadline);
                resolve();
            };

            const fail = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(deadline);
                reject(error);
            };

            try {
                if (!self.#address) {
                    self.#address = self.#defaultAddress === undefined
                        ? await self.#udp.getAddress()
                        : self.#defaultAddress;
                }

                // The deadline can fire while discovery is still in flight.
                if (settled) {
                    return;
                }

                if (self.#socket) {
                    succeed();
                    return;
                }

                self.#socket = new net.Socket();

                self.#socket.on('data', (data) => {
                    data = data.toString();
                    if (data.substr(0, 1) === 'N') {
                        let from = data.lastIndexOf('[') - 7;
                        self.emit('data', data.substr(from));
                        succeed();
                    }
                });

                // Not logged here: the error is carried up by the rejection and
                // the repository logs it with the attempt number attached.
                // Logging both printed every connect failure twice.
                self.#socket.on('error', (error) => {
                    self.#log.debug(self.constructor.name, 'socket error', error.message);
                    fail(error);
                });

                // Unsolicited close only - destroy() strips the listeners before
                // closing, so a close we asked for never lands here. Tell the
                // repository, which would otherwise keep thinking the connection
                // is OPEN and write into a dead socket, and drop the cached
                // address: a connection dying on its own is exactly when the
                // module may have moved or rebooted.
                self.#socket.on('close', () => {
                    if (established) {
                        self.#log.info('TCP Connection: Dropped');
                    } else {
                        self.#log.debug(self.constructor.name, 'socket closed before any frame');
                    }
                    self.#discard();
                    fail(new Error('Connection closed by Rinnai Touch module'));
                    self.emit('close');
                });

                self.#socket.on('ready', () => {
                    self.#log.info('TCP Connection: Open');
                });

                self.#socket.on('timeout', () => {
                    // Before the connect settles, silence is not an idle
                    // connection - it is a module that took the socket and never
                    // sent its first frame, which is simply a failed connect.
                    //
                    // It has to be settled here rather than emitted upwards. The
                    // repository's only response to 'timeout' is to queue a
                    // close, and the queue is serialized behind the request that
                    // is still awaiting this very connect - so the close could
                    // not run until the thing it was meant to abort had already
                    // finished. The 'No status received, dropping connection'
                    // warning would appear while the socket stayed up, and
                    // nothing actually dropped until the module reset it.
                    if (!established) {
                        self.#log.warn(`TCP Connection: no status frame within ${self.#idleTimeout} ms, abandoning connect`);
                        self.#discard();
                        fail(new Error('Module accepted the connection but sent no status'));
                        return;
                    }

                    self.#log.info('TCP Connection: Timed out');
                    self.emit('timeout');
                });

                self.#socket.connect(self.#address.port, self.#address.address);
                self.#socket.setTimeout(self.#idleTimeout);
            }
            catch(error) {
                self.#discard();
                fail(error);
            }
        });
    }

    /**
     * Tear down after a failure. Unlike destroy() this also forgets the
     * discovered address, so the next connect() rediscovers over UDP rather
     * than retrying an address that has just proven itself unreachable.
     */
    #discard() {
        if (this.#socket) {
            this.#socket.removeAllListeners();
            this.#socket.destroy();
            this.#socket = null;
        }
        this.#address = undefined;
    }

    destroy() {
        this.#log.debug(this.constructor.name, 'destroy');

        if (this.#socket) {
            this.#socket.removeAllListeners();
            this.#socket.destroy();
            this.#socket = null;
            this.#log.info('TCP Connection: Closed');
        }
    }

    write(data) {
        this.#log.debug(this.constructor.name, 'write', data);

        let self = this;
        return new Promise((resolve, reject) => {
            try {
                if (!self.#socket) {
                    reject(new Error('No open connection to Rinnai Touch module'));
                    return;
                }

                self.#socket.write(data, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            }
            catch(error) {
                reject(error);
            }
        });
    }
}

module.exports = RinnaiTouchTcp;
