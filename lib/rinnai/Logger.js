class Logger {
    #homeyLog;
    #debugEnabled;

    constructor(homeyLog, debugEnabled = false) {
        this.#homeyLog = homeyLog;
        this.#debugEnabled = debugEnabled;
    }

    debug(...args) {
        if (!this.#debugEnabled) {
            return;
        }
        this.#homeyLog('[debug]', ...args);
    }

    info(...args) {
        this.#homeyLog('[info]', ...args);
    }

    warn(...args) {
        this.#homeyLog('[warn]', ...args);
    }

    error(...args) {
        this.#homeyLog('[error]', ...args);
    }
}

module.exports = Logger;
