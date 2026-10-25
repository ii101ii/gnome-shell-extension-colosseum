const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class LeagueItem {
    constructor(name, open = false) {
        this.label = {text: name};
        this.menu = {isOpen: open, open() { this.isOpen = true; }};
    }
}

async function checkVersion(version) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'versions', version, 'extension.js'), 'utf8');
    const start = source.indexOf('const Colosseum =');
    const end = source.indexOf(version === '45' ? 'export default class' : 'let scores;', start);
    const managed = new Set();
    const timers = new Map();
    let nextTimer = 0;
    const context = vm.createContext({
        GObject: {registerClass: (...args) => args[args.length - 1]},
        PanelMenu: {Button: class { vfunc_event() { return 'normal'; } }},
        PopupMenu: {PopupSubMenuMenuItem: LeagueItem},
        CONSTANTS: {PREF_ALWAYS_ON: 'always-on', PREF_UPDATE_FREQ: 'update-frequency'},
        Clutter: {EventType: {BUTTON_PRESS: 1, TOUCH_BEGIN: 2}, EVENT_STOP: 'stop'},
        Main: {
            sessionMode: {isLocked: false, isGreeter: false},
            panel: {menuManager: {
                removeMenu(menu) { managed.delete(menu); },
                addMenu(menu) { managed.add(menu); },
            }},
        },
        GLib: {
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            source_remove(timer) { timers.delete(timer); },
            timeout_add_seconds(priority, seconds, callback) {
                timers.set(++nextTimer, {seconds, callback});
                return nextTimer;
            },
        },
        warn(message) { throw new Error(message); },
    });
    vm.runInContext(`${source.slice(start, end)}\nglobalThis.Scoreboard = Colosseum;`, context);
    const scoreboard = Object.create(context.Scoreboard.prototype);
    let alwaysOn = true;
    let cancelled = false;
    Object.assign(scoreboard, {
        _settings: {get_boolean: () => alwaysOn, get_int: () => 5},
        _cancellable: {is_cancelled: () => cancelled},
        _pinned: false, mapped: true, _updating: false, _refreshQueued: false,
        _timeout: null, _refreshItem: null,
        _setTopBarText() {},
        async _loadData() {},
        _createMenu() { return [new LeagueItem('NBA'), new LeagueItem('NHL')]; },
        menu: {
            isOpen: true, items: [new LeagueItem('NBA'), new LeagueItem('NHL', true)],
            _getMenuItems() { return this.items; },
            isEmpty() { return this.items.length === 0; },
            open() { this.isOpen = true; },
            close() { this.isOpen = false; },
            removeAll() { this.items = []; this.isOpen = false; },
            addMenuItem(item) { this.items.push(item); },
        },
    });
    managed.add(scoreboard.menu);
    const initialItems = scoreboard.menu.items;
    scoreboard.menu.items = [];
    scoreboard.menu.isOpen = false;
    scoreboard._syncAlwaysOn();
    assert.equal(scoreboard._pinned, false, 'defer initial pinning until scores arrive');
    scoreboard.menu.items = initialItems;
    scoreboard._onAlwaysOnChanged();
    assert.equal(managed.has(scoreboard.menu), false, 'pinned menu must not grab input');
    assert.equal(scoreboard.menu.isOpen, true, 'enabling always-on opens the scoreboard');
    assert.equal(scoreboard.menu.items[0].menu.isOpen, true, 'initial pin shows scores');
    assert.equal(timers.get(scoreboard._timeout).seconds, 60);
    scoreboard.menu.items[0].menu.isOpen = false;
    assert.equal(scoreboard.vfunc_event({type: () => 1}), 'stop');
    assert.equal(scoreboard.menu.isOpen, true, 'panel click must not collapse pinned scores');

    await scoreboard._update();
    assert.equal(scoreboard.menu.isOpen, true, 'refresh keeps the scoreboard open');
    assert.equal(scoreboard.menu.items[1].menu.isOpen, true, 'refresh preserves selected league');
    assert.equal(scoreboard.menu.items[0].menu.isOpen, false);
    assert.equal(timers.size, 1, 'refresh replaces rather than duplicates the timer');
    const timer = timers.get(scoreboard._timeout);
    timers.delete(scoreboard._timeout);
    timer.callback();
    await Promise.resolve();
    assert.equal(scoreboard.menu.isOpen, true, 'automatic refresh keeps scores visible');
    assert.equal(timers.get(scoreboard._timeout).seconds, 60);

    alwaysOn = false;
    scoreboard._onAlwaysOnChanged();
    assert.equal(managed.has(scoreboard.menu), true, 'unpin restores normal menu management');
    assert.equal(scoreboard.menu.isOpen, false);
    assert.equal(timers.get(scoreboard._timeout).seconds, 300);
    assert.equal(scoreboard.vfunc_event({type: () => 1}), 'normal');
    await scoreboard._update();
    assert.equal(scoreboard.menu.isOpen, false, 'ordinary background refresh must not open the menu');

    alwaysOn = true;
    context.Main.sessionMode.isLocked = true;
    scoreboard._syncAlwaysOn();
    assert.equal(scoreboard.menu.isOpen, false, 'do not open pinned scores on the lock screen');
    context.Main.sessionMode.isLocked = false;
    scoreboard._syncAlwaysOn();
    assert.equal(scoreboard.menu.isOpen, true, 'restore pinned scores after unlocking');
    scoreboard.menu.close();
    scoreboard.mapped = false;
    scoreboard._syncAlwaysOn();
    assert.equal(scoreboard.menu.isOpen, false, 'do not open while the panel is hidden');
    scoreboard.mapped = true;
    scoreboard._syncAlwaysOn();
    assert.equal(scoreboard.menu.isOpen, true, 'restore pinned scores when the panel returns');
    scoreboard.menu.close();
    cancelled = true;
    scoreboard._syncAlwaysOn();
    await scoreboard._update();
    assert.equal(scoreboard.menu.isOpen, false, 'disabled extension must not reopen scores');
    console.log(`${version}: always-on and refresh checks passed`);
}

(async () => {
    await checkVersion('45');
    await checkVersion('pre45');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});