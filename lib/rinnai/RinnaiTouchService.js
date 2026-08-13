const EventEmitter = require('events');
const StateService = require('./StateService');

class RinnaiTouchService extends EventEmitter {
    #log;
    #repository;
    #stateService;
    // Only these keys start out populated. TargetTemperature, AutoEnabled,
    // UserEnabled, ControlMode and ScheduleOverride are first assigned by
    // updateAll(), so they are undefined until a status frame has been read -
    // which is why the getters below reach into them with `?.`. Every setter
    // consults one of them before deciding whether the write is redundant, so
    // without that a command issued before the module was ever reached died on
    // a TypeError instead of reporting that it could not connect.
    #states = {
        ZoneName: {U: 'Common'},
        Zones: [],
        Controllers: [],
        CurrentTemperature: {},
        CurrentTemperatureOverride: {}
    };
    #timestamp = 0;
    #previousMode;
    #RinnaiTouchModes = {
        0: 'HGOM',
        1: 'CGOM',
        2: 'ECOM'
    };

    constructor(log, repository) {
        super();
        this.#log = log;
        this.#log.debug(this.constructor.name, undefined, 'log', 'repository');

        this.#repository = repository;
        this.#stateService = new StateService(log);
    }

    async init() {
        this.#log.debug(this.constructor.name, 'init');

        let status = await this.#repository.execute({type: 'get'});

        for(let state of ['HasHeater','HasCooler','HasEvap','HasMultiSP']) {
            this.#states[state] = this.#stateService.getState(state, status) === 'Y';
        }
        this.#stateService.hasMultiSetPoint = this.hasMultiSetPoint;

        // Zone Names. getState() returns undefined for an empty string as well
        // as an absent field - it tests the value for truthiness - and an
        // uninstalled or unnamed zone reports exactly that. Calling .trim() on
        // it threw out of init(), which fails the app's whole connect rather
        // than just this one label.
        for(let zone of ['A','B','C','D']) {
            let name = this.#stateService.getState('ZoneName', status, zone) ?? '';
            this.#states.ZoneName[zone] = name.trim() === ''
                ? `Zone ${zone}`
                : name.trim();
        }

        // Controllers. Rebuilt rather than appended to: init() is retried after
        // a failed connect, and pushing onto the surviving array duplicated
        // every zone - which then pairs duplicate devices and polls each zone
        // more than once.
        if (!this.hasMultiSetPoint) {
            this.#states.Controllers = ['U'];
        } else {
            let controllers = [];
            for(let zone of ['A','B','C','D']) {
                let installed = this.#stateService.getState('ZoneInstalled', status, zone);
                if (installed === 'Y') {
                    controllers.push(zone);
                }
            }
            this.#states.Controllers = controllers;
        }

        await this.updateStates();

        this.#repository.on('status', this.updateAll.bind(this));
    }

    get Modes() {
        return {HEAT: 0, COOL: 1, EVAP: 2};
    }

    get AllZones() {
        return ['U','A','B','C','D'];
    }

    get ControlModes() {
        return {MANUAL: 0, SCHEDULE: 1};
    }

    get ScheduleOverrideModes() {
        return {NONE: 0, ADVANCE: 1, OPERATION: 2};
    }

    //
    // Getters
    //
    get hasHeater() {
        this.#log.debug(this.constructor.name, 'hasHeater');
        return this.#states.HasHeater;
    }

    get hasCooler() {
        this.#log.debug(this.constructor.name, 'hasCooler');
        return this.#states.HasCooler;
    }

    get hasEvaporative() {
        this.#log.debug(this.constructor.name, 'hasEvaporative');
        return this.#states.HasEvap;
    }

    get hasMultiSetPoint() {
        this.#log.debug(this.constructor.name, 'hasMultiSetPoint');
        return this.#states.HasMultiSP;
    }

    get mode() {
        this.#log.debug(this.constructor.name, 'mode');
        return this.#states.Mode;
    }

    get zones() {
        this.#log.debug(this.constructor.name, 'zones');
        return this.#states.Zones;
    }

    get controllers() {
        this.#log.debug(this.constructor.name, 'controllers');
        return this.#states.Controllers;
    }

    getZoneName(zone) {
        this.#log.debug(this.constructor.name, 'getZoneName', zone);
        return this.#states.ZoneName[zone];
    }

    getState() {
        this.#log.debug(this.constructor.name, 'getState');
        return this.#states.State;       
    }

    getFanState() {
        this.#log.debug(this.constructor.name, 'getFanState');
        return this.#states.FanState;       
    }

    getFanSpeed() {
        this.#log.debug(this.constructor.name, 'getFanSpeed');
        return this.#states.FanSpeed;        
    }

    getTemperatureUnits() {
        this.#log.debug(this.constructor.name, 'getTemperatureUnits');
        return this.#states.TemperatureUnits;
    }

    getCurrentTemperature(zone) {
        this.#log.debug(this.constructor.name, 'getCurrentTemperature', zone);

        return this.#states.CurrentTemperatureOverride[zone] === undefined
            ? this.#states.CurrentTemperature[zone]
            : this.#states.CurrentTemperatureOverride[zone];
    }

    getTargetTemperature(zone = 'U') {
        this.#log.debug(this.constructor.name, 'getTargetTemperature', zone);
        return this.#states.TargetTemperature?.[zone];       
    }

    getSystemActive(zone) {
        this.#log.debug(this.constructor.name, 'getSystemActive', zone);
        return this.hasMultiSetPoint
            ? this.getAutoEnabled(zone)
            : this.#states.SystemActive;
    }

    getAutoEnabled(zone) {
        this.#log.debug(this.constructor.name, 'getAutoEnabled', zone);
        return this.#states.AutoEnabled?.[zone] ?? false;        
    }

    getUserEnabled(zone) {
        this.#log.debug(this.constructor.name, 'getUserEnabled', zone);
        return this.#states.UserEnabled?.[zone] ?? false;        
    }

    getControlMode(zone = 'U') {
        this.#log.debug(this.constructor.name, 'getControlMode', zone);
        return this.#states.ControlMode?.[zone];         
    }

    getScheduleOverride(zone) {
        this.#log.debug(this.constructor.name, 'getScheduleOverride', zone);
        return this.#states.ScheduleOverride?.[zone];         
    }

    getPumpState() {
        this.#log.debug(this.constructor.name, 'getPumpState');
        return this.#states.PumpState;       
    }

    //
    // Updaters
    //
    async updateStates() {
        this.#log.debug(this.constructor.name, 'updateStates');

        try {
            let status = await this.#repository.execute({type: 'get'});

            if (Date.now() - this.#timestamp < 1000) {
                return;
            }

            this.updateAll(status);
        }
        catch(error) {
            // The one error this class still handles rather than propagates.
            // Deliberately swallowed: every setter calls this first, and a stale
            // read should not fail a command that may still succeed. Callers
            // that need to know whether a read actually landed check
            // repository.lastStatusTimestamp instead (see
            // RinnaiConnection.refresh()).
            //
            // Message only, no stack: a swallowed error is not a crash, and the
            // caller that does care reports it properly. The stack here was the
            // same six frames on every failed poll.
            this.#log.warn(`Status read failed: ${error.message}`);
        }
    }

    updateAll(status) {
        this.#log.debug(this.constructor.name, 'updateAll', 'status');

        const previousStates = JSON.stringify(this.#states);

        this.updateMode(status);
        this.updateZones(status);
        this.updateState(status);
        this.updateFanState(status);
        this.updateFanSpeed(status);
        this.updateCurrentTemperature(status);
        this.updateTargetTemperature(status);
        this.updateTemperatureUnits(status);
        this.updateSystemActive(status);
        this.updateAutoEnabled(status);
        this.updateUserEnabled(status);
        this.updateControlMode(status);
        this.updateScheduleOverride(status);
        this.updatePumpState(status);

        this.#timestamp = Date.now();

        if (this.#previousMode !== this.mode) {
            if (this.#previousMode !== undefined) {
                this.emit('mode', this.mode);
            }
            this.#previousMode = this.mode; 
        }

        if (previousStates !== JSON.stringify(this.#states)) {
            this.emit('updated');
        }
    }

    updateMode(status) {
        this.#log.debug(this.constructor.name, 'updateMode', 'status');

        let state = this.#stateService.getState('Mode', status);
        let mode;
        switch (state) {
            case 'H':
                mode = this.Modes.HEAT;
                break;
            case 'C':
                mode = this.Modes.COOL;
                break;
            case 'E':
                mode = this.Modes.EVAP;
                break;
            default:
                throw new Error(`Unsupported mode '${state}'`);
        }

        this.#states.Mode = mode;
    }

    updateZones(status) {
        this.#log.debug(this.constructor.name, 'updateZones', 'status');

        let zones = [];
        for(let zone of this.AllZones) {
            let installed = this.#stateService.getState('ZoneInstalled', status, zone);
            if (installed === 'Y') {
                zones.push(zone);
            }
        }

        this.#states.Zones = zones;
    }

    /**
     * In heat/cool, State and FanState are the same protocol field
     * ({mode}.OOP.ST) read two ways - one tri-state value, not two booleans:
     *
     *   'N' heating/cooling   'Z' fan only   'F' off
     *
     * So State is "the unit is running", not "the unit is heating". Reading it
     * as state === 'N' made fan-only mode display as a powered-off device while
     * the fan was audibly blowing, and made the two capabilities behave as
     * hidden radio buttons - turning the fan on silently switched onoff off.
     *
     * Evap has genuinely separate fields (GSO.SW and GSO.FS) and is unaffected;
     * there 'F' is still the only off value, so the same test holds.
     */
    updateState(status) {
        this.#log.debug(this.constructor.name, 'updateState', 'status');

        let state = this.#stateService.getState('State', status);

        this.#states.State = state !== undefined && state !== 'F';
    }

    updateFanState(status) {
        this.#log.debug(this.constructor.name, 'updateFanState', 'status');

        let state = this.#stateService.getState('FanState', status);

        this.#states.FanState = this.mode === this.Modes.EVAP
            ? state === 'N'
            : state === 'Z';
    }

    updateFanSpeed(status) {
        this.#log.debug(this.constructor.name, 'updateFanSpeed', 'status');

        let state = this.#stateService.getState('FanSpeed', status);

        this.#states.FanSpeed = parseInt(state, 10);
    }

    updateTemperatureUnits(status) {
        this.#log.debug(this.constructor.name, 'updateTemperatureUnits', 'status');

        let state = this.#stateService.getState('TempUnits', status);

        this.#states.TemperatureUnits = state;
    }

    updateCurrentTemperature(status) {
        this.#log.debug(this.constructor.name, 'updateCurrentTemperature', 'status');

        for(let zone of this.AllZones) {
            let state = this.#stateService.getState('CurrentTemp', status, zone);
            if (state !== '999') {
                this.#states.CurrentTemperature[zone] = parseFloat(state) / 10.0;
            }
        }
    }

    updateTargetTemperature(status) {
        this.#log.debug(this.constructor.name, 'updateTargetTemperature', 'status');

        let states = {};
        let zones = this.hasMultiSetPoint ? this.controllers : ['U'];
        for(let zone of zones) {
            let state = this.#stateService.getState('TargetTemp', status, zone);
            if (state) {
                states[zone] = this.decodeTargetTemperature(state);
            }
        }

        this.#states.TargetTemperature = states;
    }

    updateSystemActive(status) {
        this.#log.debug(this.constructor.name, 'updateSystemActive', 'status');

        if (!this.hasMultiSetPoint) {
            let state = this.#stateService.getState('SystemActive', status);
            if (state) {
                this.#states.SystemActive = state === 'Y';
            }
        }
    }

    updateAutoEnabled(status) {
        this.#log.debug(this.constructor.name, 'updateAutoEnabled', 'status');

        let states = {};
        for(let zone of this.AllZones) {
            let state = this.#stateService.getState('AutoEnabled', status, zone);
            states[zone] = state === 'Y';
        }

        this.#states.AutoEnabled = states;    
    }

    updateUserEnabled(status) {
        this.#log.debug(this.constructor.name, 'updateUserEnabled', 'status');

        let states = {};
        for(let zone of this.AllZones) {
            let state = this.#stateService.getState('UserEnabled', status, zone);
            states[zone] = state === 'Y';
        }

        this.#states.UserEnabled = states;    
    }

    updateControlMode(status) {
        this.#log.debug(this.constructor.name, 'updateControlMode', 'status');

        let states = {};
        let zones = this.hasMultiSetPoint ? this.controllers : ['U'];
        for(let zone of zones) {
            let state = this.#stateService.getState('ControlMode', status, zone);
            if (state !== undefined) {
                states[zone] = state === 'M'
                    ? this.ControlModes.MANUAL
                    : this.ControlModes.SCHEDULE;
            }
        }

        this.#states.ControlMode = states;
    }

    updateScheduleOverride(status) {
        this.#log.debug(this.constructor.name, 'updateScheduleOverride', 'status');

        let states = {};
        let zones = this.hasMultiSetPoint ? this.controllers : ['U'];
        for(let zone of zones) {
            let state = this.#stateService.getState('ScheduleOverride', status, zone);
            if (state !== undefined) {
                switch(state) {
                    case 'N':
                        states[zone] = this.ScheduleOverrideModes.NONE;
                        break;
                    case 'A':
                        states[zone] = this.ScheduleOverrideModes.ADVANCE;
                        break;
                    case 'O':
                        states[zone] = this.ScheduleOverrideModes.OPERATION;
                        break;
                    default:
                        // Leave the zone unset rather than guessing. This is a
                        // reverse engineered protocol, so an unknown value is a
                        // gap in what we know, not a state to invent.
                        this.#log.warn(`Ignoring unknown schedule override '${state}' for zone ${zone}`);
                }
            }
        }

        this.#states.ScheduleOverride = states;
    }

    updatePumpState(status) {
        this.#log.debug(this.constructor.name, 'updatePumpState', 'status');

        let state = this.#stateService.getState('PumpState', status);

        this.#states.PumpState = state === 'N';
    }

    //
    // Setters
    //
    async setMode(value) {
        this.#log.debug(this.constructor.name, 'setMode', value);

        await this.updateStates();

        if (this.mode === value) {
            return;
        }

        let path = this.#stateService.getPath('Mode');
        let state = this.#RinnaiTouchModes[value].substr(0, 1);

        await this.sendRequest(path, state);
    }

    async setState(value) {
        this.#log.debug(this.constructor.name, 'setState', value);

        await this.updateStates();

        if (this.getState() === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('State', mode);
        // Turning on always lands on 'N' rather than preserving fan-only: this
        // is only reached when the unit is off, and "on" from off means
        // heating/cooling. Off is 'F' from either running value.
        let state = value ? 'N' : 'F';

        await this.sendRequest(path, state);
    }

    async setFanState(value) {
        this.#log.debug(this.constructor.name, 'setFanState', value);

        await this.updateStates();

        if (this.getFanState() === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('FanState', mode);
        let state;

        if (this.mode === this.Modes.EVAP) {
            state = value ? 'N' : 'F';
        }
        else {
            // Heat/cool share one field with State (see updateState), so what
            // "fan off" means depends on the rest of that field. Reaching here
            // means the fan is currently on, i.e. ST is 'Z' and the unit is
            // running - so turning the fan off returns it to heating/cooling
            // rather than switching it off. Switching off is setState()'s job,
            // and sending 'F' here would make the fan toggle a second power
            // switch with no way back to 'N'.
            state = value ? 'Z' : 'N';
        }

        await this.sendRequest(path, state);
    }

    async setFanSpeed(value) {
        this.#log.debug(this.constructor.name, 'setFanSpeed', value);

        await this.updateStates();

        if (this.getFanSpeed() === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('FanSpeed', mode);
        let state = value.toString().padStart(2, '0');

        await this.sendRequest(path, state);
    }

    setCurrentTemperatureOverride(value, zone) {
        this.#log.debug(this.constructor.name, 'setCurrentTemperatureOverride', value, zone);

        if (this.#states.CurrentTemperatureOverride[zone] !== value) {
            this.#states.CurrentTemperatureOverride[zone] = value;
            this.emit('updated');
        }
    }

    async setTargetTemperature(value, zone = 'U') {
        this.#log.debug(this.constructor.name, 'setTargetTemperature', value, zone);

        await this.updateStates();

        let state = this.encodeTargetTemperature(value);
        let current = this.getTargetTemperature(zone);

        // Compare what will actually go on the wire, not the temperatures on
        // either side of the conversion. In evap, 23 temperatures map onto 16
        // comfort levels, so distinct setpoints encode identically - and
        // comparing temperatures let those through as real commands. The module
        // was already at that comfort level, so its status never changed,
        // commandSucceeded() never saw the value appear, and all three attempts
        // ran to their 10 sec timeout: 30 sec holding the serialized queue, then
        // a failure with nothing the user could do about it.
        if (current !== undefined && this.encodeTargetTemperature(current) === state) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('TargetTemp', mode, zone);

        await this.sendRequest(path, state.toString().padStart(2, '0'));
    }

    // Zone Switch
    async setUserEnabled(value, zone) {
        this.#log.debug(this.constructor.name, 'setUserEnabled', value, zone);

        await this.updateStates();

        if (this.getUserEnabled(zone) === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('UserEnabled', mode, zone);
        let state = value ? 'Y' : 'N';

        await this.sendRequest(path, state);
    }

    async setControlMode(value, zone = 'U') {
        this.#log.debug(this.constructor.name, 'setControlMode', value, zone);

        await this.updateStates();

        if (this.getControlMode(zone) === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('ControlMode', mode, zone);
        let state = value === this.ControlModes.MANUAL ? 'M' : 'A';

        await this.sendRequest(path, state);
    }

    async setScheduleOverride(value, zone) {
        this.#log.debug(this.constructor.name, 'setScheduleOverride', value, zone);

        await this.updateStates();

        if (this.getScheduleOverride(zone) === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('ScheduleOverride', mode, zone);
        let state;
        switch (value) {
            case this.ScheduleOverrideModes.NONE:
                state = 'N';
                break;
            case this.ScheduleOverrideModes.ADVANCE:
                state = 'A';
                break;
            case this.ScheduleOverrideModes.OPERATION:
                state = 'O';
                break;
            default:
                throw new Error(`Unsupported schedule override '${value}'`);
        }

        await this.sendRequest(path, state);
    }

    async setPumpState(value) {
        this.#log.debug(this.constructor.name, 'setPumpState', value);

        await this.updateStates();

        if (this.getPumpState() === value) {
            return;
        }

        let mode = this.getRinnaiTouchMode();
        let path = this.#stateService.getPath('PumpState', mode);
        let state = value ? 'N' : 'F';

        await this.sendRequest(path, state);
    }

    //
    // Helpers
    //
    getRinnaiTouchMode() {
        this.#log.debug(this.constructor.name, 'getRinnaiTouchMode');

        return this.#RinnaiTouchModes[this.mode];
    }

    /**
     * Target temperature as the module stores it. Heat/cool is degrees; evap is
     * a "comfort level" of 19-34 that the app presents as 8-30 degrees so one
     * capability can serve every mode.
     *
     * The mapping is lossy in one direction only: 23 temperatures onto 16
     * comfort levels, so a temperature the user picks may encode to a level
     * that decodes back to its neighbour (10 -> 20 -> 9). That is quantisation,
     * not a rounding bug - only 16 setpoints are reachable. Encoding is stable
     * the other way, so encode(decode(level)) === level for all 16, which is
     * what lets setTargetTemperature() compare encoded values safely.
     */
    encodeTargetTemperature(value) {
        let target = parseInt(value, 10);

        return this.mode === this.Modes.EVAP
            ? Math.round((target - 8) / 22 * 15 + 19)
            : target;
    }

    decodeTargetTemperature(state) {
        return this.mode === this.Modes.EVAP
            ? Math.round((parseInt(state, 10) - 19) / 15 * 22 + 8)
            : parseInt(state, 10);
    }

    async sendRequest(path, state) {
        this.#log.debug(this.constructor.name, 'sendRequest', path, state);

        // Every command is built out of the last status frame: the mode picks
        // the path's group and the repository takes the sequence number from it.
        // Before the first successful read both are undefined and the command
        // serialises to nonsense - N000NaN{"undefined":{"GSO":{"SP":"22"}}} -
        // which then fails at the socket with whatever error the write happens
        // to raise, burying the real one. Say what is actually wrong instead.
        if (this.mode === undefined) {
            throw new Error('No status has been read from the module yet');
        }

        if (path === undefined || state === undefined) {
            this.#log.warn('Invalid request. Cannot send command');
            return;
        }

        let request = {
            type: 'set',
            path: path,
            state: state
        };

        await this.#repository.execute(request);
    }
}

module.exports = RinnaiTouchService;