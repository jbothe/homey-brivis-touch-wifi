class StateService {
    #log;
    #systemPaths = {
        HasMultiSP: 'SYST.CFG.MTSP',
        TempUnits:	'SYST.CFG.TU',
        ZoneName:	'SYST.CFG.Z{zone}',
        HasHeater:	'SYST.AVM.HG',
        HasCooler: 	'SYST.AVM.CG',
        HasEvap: 	'SYST.AVM.EC',
        Mode:		'SYST.OSS.MD',
    };
    #heatCoolPaths = {
        State:		    '{mode}.OOP.ST',    // oN, ofF
        FanState:	    '{mode}.OOP.ST',    // ofF, fanZ
        FanSpeed:	    '{mode}.OOP.FL',    // nn 01 - 16
        
        ControlMode:	'{mode}.{gz}O.OP',  // Auto, Manual
        TargetTemp:		'{mode}.{gz}O.SP',  // nn (08 - 30)
        ScheduleOverride:	'{mode}.{gz}O.AO',  // None, Advance, Operation
        
        SystemActive:   '{mode}.GSS.{m}C',  // Y,N
        SchedulePeriod:	'{mode}.{gz}S.AT',  // Wake, Leave, Return, Presleep, Sleep  

        CurrentTemp:	'{mode}.Z{zone}S.MT',   // nnn
        AutoEnabled:	'{mode}.Z{zone}S.AE',   // Y,N (is heating/cooling)
        UserEnabled:	'{mode}.Z{zone}O.UE',   // Y,N (Zone switch)

        ZoneInstalled:	'{mode}.CFG.Z{zone}IS'   // Y,N      
    };
    #evapPaths = {
        State:		    'ECOM.GSO.SW',  // oN, ofF
        FanState:		'ECOM.GSO.FS',  // oN, ofF	
        FanSpeed:		'ECOM.GSO.FL',  // nn 01 - 16
        
        ControlMode:	'ECOM.GSO.OP',  // Auto, Manual
        // Not a TargetTemp: the "comfort level" the Networker maintains in
        // Auto, shown there as 1 - 16, inverted on the wire (see
        // RinnaiTouchService). Manual has no setpoint, and the module rejects
        // writes to this one while in it.
        ComfortLevel:	'ECOM.GSO.SP',  // nn (19 coolest - 34 warmest)

        // No SystemActive: GSS.BY, mapped here before, reads N even while the
        // cooler runs. RinnaiTouchService#getSystemActive uses FO / PO instead.
        CurrentTemp:	'ECOM.GSS.MT',  // nnn
        AutoEnabled:	'ECOM.GSS.Z{zone}AE',   // Y,N (is cooling)

        UserEnabled:	'ECOM.GSO.Z{zone}UE',	// Y,N (Zone switch)

        ZoneInstalled:	'ECOM.CFG.Z{zone}IS',   // Y,N
        
        PumpState:		'ECOM.GSO.PS',  // oN, ofF

        // What the cooler is actually doing. In Auto the module drops FS, FL and
        // PS from GSO - the Networker runs them - and reports these instead.
        // Fan speed has no counterpart: in Auto it is not reported at all.
        FanRunning:		'ECOM.GSS.FO',  // Y,N
        PumpRunning:	'ECOM.GSS.PO',  // Y,N
        // Wetting the pads before the fan starts, ~8 min on switching on in
        // Auto: pump running, fan not yet.
        PreWet:			'ECOM.GSS.PW'   // Y,N
    };

    constructor(log) {
        this.#log = log;
        this.#log.debug(this.constructor.name, undefined, 'log');

        this.hasMultiSetPoint = false;
    }


    getState(state, status, zone) {
        this.#log.debug(this.constructor.name, 'getState', state, zone);

        // status[1] is the mode group (HGOM, CGOM or ECOM), and the module
        // does not always send it: frames with only SYST have been seen in the
        // field. Paths into it then resolve to nothing, as an absent field does.
        let mode = Object.keys(status?.[1] ?? {})[0];
        let path = this.getPath(state, mode, zone);
        if (path === undefined) {
            return;
        }

        let [group1, group2, cmd] = path.split('.');
        let item = group1 === 'SYST' ? 0 : 1;

        return status?.[item]?.[group1]?.[group2]?.[cmd] || undefined;
    }

    getPath(state, mode, zone) {
        this.#log.debug(this.constructor.name, 'getPath', state, mode, zone);

        let path = this.#systemPaths[state];
        if (path === undefined) {
            path = mode !== 'ECOM'
                ? this.#heatCoolPaths[state]
                : this.#evapPaths[state];
        }

        if (path === undefined) {
            return;
        }

        path = path
            .replace('{mode}', mode)
            .replace('{m}', mode ? mode.substr(0, 1) : '')
            .replace('{gz}', this.hasMultiSetPoint ? 'Z{zone}' : 'GS')
            .replace('{zone}', zone);

        return path;
    }
}

module.exports = StateService;