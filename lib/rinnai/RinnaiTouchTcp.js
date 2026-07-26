const RinnaiTouchUdp = require('./RinnaiTouchUdp');
const net = require('net');
var EventEmitter = require('events');

// Ceiling on a single connect() attempt, covering UDP discovery, the TCP
// handshake and the module's first status frame. The promise below only settles
// on a status frame or a socket error, and there are two ways to get neither:
// a stale cached address that black-holes packets (the OS takes ~75 sec to give
// up), and a module that accepts the socket but never pushes a frame. Both
// leave the repository's serialised queue blocked behind a pending connect.
const DEFAULT_CONNECT_TIMEOUT = 10000;

// Socket-level idle timeout. Only reported upwards as 'timeout' - the
// repository owns the decision of what a silent connection means, since that
// depends on whether it is holding the connection open deliberately.
const IDLE_TIMEOUT = 5000;

class RinnaiTouchTcp extends EventEmitter {
    #log;
    #udp;
    #defaultAddress;
    #address;
    #socket;
    #connectTimeout;

    constructor(log, address, timeout = 5000, connectTimeout = DEFAULT_CONNECT_TIMEOUT) {
        super();
        this.#log = log;
        this.#defaultAddress = address;
        this.#connectTimeout = connectTimeout;
        this.#log.debug(this.constructor.name, undefined, 'log', JSON.stringify(address), timeout);
        this.#udp = new RinnaiTouchUdp(log, timeout);
    }

    connect() {
        this.#log.debug(this.constructor.name, 'connect');

        let self = this;
        return new Promise(async (resolve, reject) => {
            let settled = false;

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

                self.#socket.on('error', (error) => {
                    self.#log.warn(`TCP Connection: ${error.message}`);
                    fail(error);
                });

                // Unsolicited close only - destroy() strips the listeners before
                // closing, so a close we asked for never lands here. Tell the
                // repository, which would otherwise keep thinking the connection
                // is OPEN and write into a dead socket, and drop the cached
                // address: a connection dying on its own is exactly when the
                // module may have moved or rebooted.
                self.#socket.on('close', () => {
                    self.#log.info('TCP Connection: Dropped');
                    self.#discard();
                    fail(new Error('Connection closed by Rinnai Touch module'));
                    self.emit('close');
                });

                self.#socket.on('ready', () => {
                    self.#log.info('TCP Connection: Open');
                });

                self.#socket.on('timeout', () => {
                    self.#log.info('TCP Connection: Timed out');
                    self.emit('timeout');
                });

                self.#socket.connect(self.#address.port, self.#address.address);
                self.#socket.setTimeout(IDLE_TIMEOUT);
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
