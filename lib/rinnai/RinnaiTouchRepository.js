const RinnaiTouchTcp = require('./RinnaiTouchTcp');
const EventEmitter = require('events');
const cq = require('concurrent-queue');

class RinnaiTouchRepository extends EventEmitter {
    #log;
    #connectionCloseDelay;
    #idleCloseDelay;
    #connectionStates = {
        OPEN: 0,
        CLOSING: 1,
        CLOSED: 2
    };
    #connectionState;
    #timer;
    #tcp;
    #queue;
    #sequenceNumber;
    #status;
    #timestamp;
    #previousStatus;
    #address;

    constructor(log, settings) {
        super();
        this.#log = log;
        this.#log.debug(this.constructor.name, undefined, 'log', 'settings');

        this.#connectionCloseDelay = settings.closeConnectionDelay;
        this.#idleCloseDelay = settings.idleCloseDelay;
        this.#connectionState = this.#connectionStates.CLOSED;

        if (settings.address) {
            this.#address = {
                address: settings.address,
                port: settings.port || 27847
            };
        }

        // undefined for the UDP timeout keeps RinnaiTouchTcp's own default;
        // only the connect deadline is worth tuning from here.
        this.#tcp = new RinnaiTouchTcp(log, this.#address, undefined, settings.connectTimeout);
        this.#tcp.on('data', this.dataHandler.bind(this));
        this.#tcp.on('close', this.connectionLost.bind(this));
        this.#tcp.on('timeout', this.timeoutHandler.bind(this));

        this.#queue = cq()
            .limit({ concurrency: 1 })
            .process(this.process.bind(this));

        this.#queue.drained(this.drained.bind(this));
    }

    // Errors are propagated, not logged: process() below rethrows into here and
    // every caller either logs or rethrows again. Logging at each of those
    // layers printed the same stack three times per failed poll.
    async execute(request) {
        this.#log.debug(this.constructor.name, 'execute', JSON.stringify(request));

        return this.#queue(request);
    }

    /**
     * How long ago the last status frame arrived, or Infinity if none has
     * arrived since the connection was last lost. Never subtract #timestamp
     * directly: it is undefined until the first frame and again after
     * connectionLost(), and `Date.now() - undefined` is NaN, which compares
     * false against everything - so a connection that has never produced a
     * frame reads as fresh rather than stale.
     */
    #statusAge() {
        return this.#timestamp === undefined
            ? Infinity
            : Date.now() - this.#timestamp;
    }

    async process(request) {
        this.#log.debug(this.constructor.name, 'process', JSON.stringify(request));

        if (request.type === 'close') {
            await this.closeConnection();
            return;
        }

        if (request.type === 'get' && this.#statusAge() <= 1000) {
            return this.#status;
        }

        clearTimeout(this.#timer);
        if (this.#connectionState === this.#connectionStates.OPEN) {
            // If no status receieved for > 2 sec then close connection.
            if (this.#statusAge() > 2000) {
                await this.closeConnection();
            }
        }
        else if (this.#connectionState === this.#connectionStates.CLOSING) {
            await this.connectionClosed();
        }
        if (this.#connectionState === this.#connectionStates.CLOSED) {
            await this.connect();
            this.#connectionState = this.#connectionStates.OPEN;
        }

        // Wait for new status to be emitted from tcp
        if (request.type === 'get') {
            let ts = this.#timestamp;
            for(let i = 0; i < 10; i++) {
                await this.delay(500);
                // connectionLost() clears the timestamp, so test for a real
                // frame rather than just a change - otherwise the connection
                // dropping mid-wait would return the stale status as if it
                // had just been refreshed.
                if (this.#timestamp !== undefined && ts !== this.#timestamp) {
                    return this.#status;
                }
            }
            throw new Error('Failed to get new status');
        }

        let command = this.getCommand(request);
        this.#log.info(`Sending Command: ${command}`);
        for(let i = 1; i <= 3; i++) {
            await this.#tcp.write(command);

            let success = await this.commandSucceeded(command);
            if (success) {
                return;
            }
            this.#log.warn(`Command failed. Attempt ${i} of 3`);
        }

        // Falling out of the loop used to return undefined, which read as
        // success all the way back to the capability listener - the module
        // never took the command but Homey kept the optimistic value.
        throw new Error(`Command was not accepted by the module: ${command}`);
    }

    async connect() {
        this.#log.debug(this.constructor.name, 'connect');

        let lastError;
        for(let i = 1; i <= 3; i++) {
            try {
                await this.#tcp.connect();
                return;
            }
            catch(error) {
                lastError = error;
                this.#log.warn(`TCP Connection failed. ${error.message}. Attempt ${i} of 3`);
                // No point sleeping after the last attempt - that delay only
                // exists to give the module a moment before we try again.
                if (i < 3) {
                    await this.delay(500);
                }
            }
        }
        // Carry the reason up. 'Unable to connect' on its own told the poll
        // nothing about whether the module refused us, went silent, or was
        // never discovered at all.
        throw new Error(`Unable to connect: ${lastError.message}`);
    }

    getCommand(request) {
        this.#log.debug(this.constructor.name, 'getCommand', JSON.stringify(request));

        let sequenceNumber = ((this.#sequenceNumber + 1) % 255).toString().padStart(6, '0');

        if (request.type === 'set') {
            let path = request.path.split('.');
            return `N${sequenceNumber}{"${path[0]}":{"${path[1]}":{"${path[2]}":"${request.state}"}}}`;
        }

        return `N${sequenceNumber}${request.command}`;
    }

    commandSucceeded(command) {
        this.#log.debug(this.constructor.name, 'commandSucceeded', command);

        let json = JSON.parse(command.substr(7));
        let group1 = Object.keys(json)[0];
        let group2 = Object.keys(json[group1])[0];
        let cmd = Object.keys(json[group1][group2])[0];
        let state = json[group1][group2][cmd];
        let item = group1 === 'SYST' ? 0 : 1;
        let timer;
        let startTime;
        let checkStatus;

        return new Promise((resolve, reject) => {
            try {
                startTime = Date.now();

                timer = setTimeout(() => {
                    this.off('status', checkStatus);
                    resolve(false);
                }, 10000);

                checkStatus = (status) => {
                    if (status[item][group1] === undefined || status[item][group1][group2] === undefined) {
                        return;
                    }

                    if (status[item][group1][group2][cmd] === state) {
                        clearTimeout(timer);
                        this.#log.info(`Command succeeded. Took ${Date.now() - startTime} ms`);
                        this.off('status', checkStatus);
                        resolve(true);
                    } 
                }              

                this.on('status', checkStatus);
            }
            catch(error) {
                this.off('status', checkStatus);
                reject(error);
            }
        });
    }

    async drained() {
        this.#log.debug(this.constructor.name, 'drained');

        if (this.#connectionState !== this.#connectionStates.OPEN) {
            return;
        }

        if (this.#idleCloseDelay < 0) {
            return;
        }

        if (this.#idleCloseDelay === 0) {
            await this.execute({type: 'close'});
            return;
        }

        this.#timer = setTimeout(async () => {
            await this.execute({type: 'close'});
        }, this.#idleCloseDelay);
    }

    async closeConnection() {
        this.#log.debug(this.constructor.name, 'closeConnection');

        try {
            if (this.#connectionState !== this.#connectionStates.OPEN) {
                return;
            }

            this.#connectionState = this.#connectionStates.CLOSING;
            this.#tcp.destroy();
            await this.delay(this.#connectionCloseDelay);
            this.#connectionState = this.#connectionStates.CLOSED;
        }
        catch(error) {
            this.#log.error(error);
        }
    }

    /**
     * An established connection went quiet. What that means depends on why it
     * is open.
     *
     * Only established connections reach here: a socket that goes silent before
     * its connect() settles is failed by RinnaiTouchTcp itself, because the
     * close this would queue cannot run until that connect finishes.
     */
    timeoutHandler() {
        this.#log.debug(this.constructor.name, 'timeoutHandler');

        // Keep-alive mode: we are holding the connection open deliberately, so
        // poke the module rather than dropping it.
        if (this.#idleCloseDelay < 0) {
            this.execute({type: 'get'}).catch(() => undefined);
            return;
        }

        // Otherwise the module streams status continuously while connected, so
        // silence means the socket is half-open. Close it through the queue so
        // the usual close delay still applies before anything reconnects - and
        // so a close never lands in the middle of a command being confirmed.
        this.#log.warn('TCP Connection: No status received, dropping connection');
        this.execute({type: 'close'}).catch(() => undefined);
    }

    /**
     * The connection died without us asking. The socket is already gone, so
     * there is nothing to close - but the state machine still thinks it is
     * OPEN, and would happily write into it.
     */
    connectionLost() {
        this.#log.debug(this.constructor.name, 'connectionLost');

        clearTimeout(this.#timer);
        this.#timestamp = undefined;

        if (this.#connectionState === this.#connectionStates.CLOSED) {
            return;
        }

        // Mirror closeConnection()'s grace period: the module needs a moment to
        // free its single connection slot before it will accept a new one.
        this.#connectionState = this.#connectionStates.CLOSING;
        setTimeout(() => {
            this.#connectionState = this.#connectionStates.CLOSED;
        }, this.#connectionCloseDelay);
    }

    /**
     * When the last status frame arrived, or undefined if the connection has
     * since been lost. Used to tell a poll that genuinely refreshed state from
     * one that quietly failed - see RinnaiConnection.refresh().
     */
    get lastStatusTimestamp() {
        return this.#timestamp;
    }

    dataHandler(message) {
        this.#log.debug(this.constructor.name, 'dataHandler', message);

        this.#sequenceNumber = parseInt(message.substr(1, 6));
        this.#timestamp = Date.now();
        const newStatus = message.substr(7);
        if (this.#previousStatus !== newStatus) {
            this.#status = JSON.parse(newStatus);
            this.#previousStatus = newStatus;
            this.emit('status', this.#status);
        }
    }

    async delay(ms) {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    async connectionClosed() {
        this.#log.debug(this.constructor.name, 'connectionClosed');

        for(let i = 0; i < 10; i++) {
            await this.delay(500);
            if (this.#connectionState === this.#connectionStates.CLOSED) {
                return;
            }
        }
        throw new Error('Connection was not closed within time limit');
    }
}

module.exports = RinnaiTouchRepository