const dgram = require('dgram');

class RinnaiTouchUdp {
    #log;
    #timeout;
    #port = 50000;
    // The address the last info line reported. Discovery runs on every connect
    // attempt (a failed connect forgets the cached address), so announcing the
    // result every time meant three identical lines per failed poll forever -
    // while the module is unreachable it is the connect that fails, not this.
    #announced;

    constructor(log, timeout = 5000) {
        this.#log = log;
        this.#log.debug(this.constructor.name, undefined, 'log', timeout);
        this.#timeout = timeout;
    }

    getAddress() {
        this.#log.debug(this.constructor.name, 'getAddress');

        let self = this;
        return new Promise((resolve, reject) => {
            let socket = dgram.createSocket('udp4');

            let timer = setTimeout(() => {
                socket.removeAllListeners();
                socket.close();
                reject(new Error('Timeout occured. No UDP message received from Rinnai Touch Module'));
            }, self.#timeout);
    
            socket.on('message', (message, remote) => {
                if (message.toString().substr(0, 18) === 'Rinnai_NBW2_Module') {
                    clearTimeout(timer);
                    socket.removeAllListeners();
                    socket.close();
                    const port = message[32] * 256 + message[33];
                    const found = `${remote.address}:${port}`;
                    if (self.#announced === found) {
                        self.#log.debug(self.constructor.name, 'getAddress', found);
                    } else {
                        self.#announced = found;
                        self.#log.info(`Found Rinnai Touch module at ${found}`);
                    }
                    resolve({
                        address: remote.address,
                        port: port
                    });
                }            
            });
    
            socket.on('error', (error) => {
                clearTimeout(timer);
                socket.removeAllListeners();
                socket.close();
                reject(error);
            });
    
            socket.bind(self.#port);
        });
    }
}

module.exports = RinnaiTouchUdp;