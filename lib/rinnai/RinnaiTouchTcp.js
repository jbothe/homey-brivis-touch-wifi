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

// A frame is 'N', a six digit sequence number, then a JSON array payload.
const FRAME_HEADER = /N\d{6}\[/;
const HEADER_LENGTH = 7;

// TCP is a byte stream, not a message channel. A status payload for a
// multi-zone system runs past one segment, so frames arrive split - and while
// the module is streaming they also arrive coalesced. Beyond this length we are
// not part-way through a frame, we have lost sync with the stream: drop what we
// have rather than buffer without bound.
const MAX_FRAME_LENGTH = 65536;

class RinnaiTouchTcp extends EventEmitter {
    #log;
    #udp;
    #defaultAddress;
    #address;
    #socket;
    #connectTimeout;
    #idleTimeout;
    #buffer = '';

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

        // The work is async but the executor is not: an async executor swallows
        // anything thrown before the first await, since there is no caller left
        // to catch it. #openConnection() settles the promise itself and its body
        // is wrapped in a try/catch, so nothing escapes.
        return new Promise((resolve, reject) => {
            this.#openConnection(resolve, reject).catch(reject);
        });
    }

    /**
     * Resolves the address (cached, configured, or discovered over UDP), opens
     * the socket, and settles via `resolve`/`reject` on the first status frame,
     * a socket error, or the connect deadline - whichever comes first.
     */
    async #openConnection(resolve, reject) {
        let self = this;
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
                // Only the first frame settles the connect; the rest just
                // flow on to the repository.
                if (self.#consume(data.toString())) {
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
    }

    /**
     * Accumulate a chunk and emit every complete frame it completes. Returns
     * whether any frame was emitted.
     *
     * The previous version read each chunk as exactly one frame, taking the
     * payload from the last '[' in it. That holds only while frames arrive
     * whole and alone, which they do not: a truncated chunk still starting with
     * 'N' was passed on and threw out of JSON.parse in the repository's data
     * handler - a synchronous socket callback, so an unhandled throw that takes
     * the app down. Continuation chunks, not starting with 'N', were dropped,
     * so the rest of that frame was lost too.
     */
    #consume(chunk) {
        this.#buffer += chunk;
        let emitted = false;

        for (;;) {
            const start = this.#buffer.search(FRAME_HEADER);
            if (start < 0) {
                // Nothing framable in view. Bytes ahead of a header are
                // unusable, but the tail may be a header still arriving, so
                // keep back just enough to complete one.
                if (this.#buffer.length > HEADER_LENGTH) {
                    this.#buffer = this.#buffer.slice(-HEADER_LENGTH);
                }
                return emitted;
            }
            if (start > 0) {
                this.#buffer = this.#buffer.slice(start);
            }

            const end = this.#endOfPayload();
            if (end < 0) {
                if (this.#buffer.length > MAX_FRAME_LENGTH) {
                    this.#log.warn(`TCP Connection: discarding ${this.#buffer.length} bytes with no complete frame`);
                    this.#buffer = '';
                }
                return emitted;
            }

            const frame = this.#buffer.slice(0, end + 1);
            this.#buffer = this.#buffer.slice(end + 1);
            this.emit('data', frame);
            emitted = true;
        }
    }

    /**
     * Index of the ']' closing the payload of the frame at the head of the
     * buffer, or -1 if it has not arrived yet. Counts bracket depth rather than
     * scanning for the last ']', since zone names are free text and may contain
     * brackets of their own - hence tracking string state and escapes.
     */
    #endOfPayload() {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = HEADER_LENGTH; i < this.#buffer.length; i++) {
            const char = this.#buffer[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
            } else if (char === '[' || char === '{') {
                depth += 1;
            } else if (char === ']' || char === '}') {
                depth -= 1;
                if (depth === 0) {
                    return i;
                }
            }
        }

        return -1;
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
        this.#buffer = '';
        this.#address = undefined;
    }

    destroy() {
        this.#log.debug(this.constructor.name, 'destroy');

        if (this.#socket) {
            this.#socket.removeAllListeners();
            this.#socket.destroy();
            this.#socket = null;
            this.#buffer = '';
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
