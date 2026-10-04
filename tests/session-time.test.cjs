const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(file) {
    return fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
}
function extract(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' exists');
    return source.slice(start, source.indexOf('\n}', start) + 2);
}
function tracker(file) {
    const source = read(file), requests = [], events = {}, timers = new Map();
    let clock = 1000000, nextId = 0, nextTimer = 0;
    const document = { visibilityState: 'visible', addEventListener: (name, fn) => { events[name] = fn; } };
    const ctx = vm.createContext({
        Date: { now: () => clock }, document,
        window: { addEventListener: (name, fn) => { events[name] = fn; } },
        SUPABASE_URL: 'https://project.example', SUPABASE_KEY: 'public-test-key',
        publicAuthAccessToken: 'test-token', publicAuthUserId: 'authenticated-viewer',
        miniAppAuthAccessToken: 'test-token', miniAppAuthUserId: 'authenticated-viewer',
        LIBRARY_VIEWER_ID: 'local-viewer', LIBRARY_PLATFORM: file === 'index.html' ? 'website' : 'mini_app',
        libraryViewActive: false, console: { warn() {} },
        createWatchTimeId: () => 'id-' + ++nextId,
        setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; },
        clearInterval: id => timers.delete(id),
        fetch: async (url, options) => {
            requests.push({ url, ...JSON.parse(options.body), keepalive: options.keepalive });
            return { ok: true };
        },
        stopLibraryActivityTracking() {}, stopLikeCountFallback() {}, recordLibraryActivity() {}
    });
    const names = ['captureViewerTime', 'sendViewerTimeHeartbeat', 'startViewerTimeTracking', 'switchViewerTimeContext', 'stopViewerTimeTracking'];
    const visibilityStart = source.indexOf('document.addEventListener("visibilitychange",function(){', source.indexOf('function recordLibraryActivity('));
    const listeners = source.slice(visibilityStart, source.indexOf('function normalizeLibraryIds(', visibilityStart));
    vm.runInContext('const VIEWER_TIME_HEARTBEAT_MS = 10000; let viewerTimeState = null; let viewerTimeTimer = null; let viewerVisitId = null; let viewerTimeHasStarted = false;\n' + names.map(name => extract(source, name)).join('\n') + listeners, ctx);
    return { ctx, requests, events, document, timers, advance: ms => { clock += ms; } };
}

for (const file of ['index.html', 'telegram.html']) {
    test(file + ': Library transitions share one visit, with separate context durations', async () => {
        const t = tracker(file);
        t.ctx.startViewerTimeTracking('outside');
        t.advance(10000);
        t.ctx.switchViewerTimeContext('library');
        t.advance(5000);
        t.ctx.switchViewerTimeContext('outside');
        t.advance(15000);
        await t.ctx.sendViewerTimeHeartbeat();
        assert.equal(new Set(t.requests.map(r => r.p_visit_id)).size, 1);
        assert.equal(new Set(t.requests.map(r => r.p_session_id)).size, 3);
        const latest = new Map(t.requests.map(r => [r.p_session_id, r]));
        assert.equal([...latest.values()].reduce((sum, r) => sum + r.p_duration_seconds, 0), 30);
        assert.ok(t.requests.every(r => r.url.endsWith('/rpc/record_viewer_visit_time')));
        assert.ok(t.requests.every(r => r.p_viewer_id === 'authenticated-viewer' && r.keepalive));
        assert.equal(t.timers.size, 1);
    });

    test(file + ': time in a hidden tab does not increase session duration', async () => {
        const t = tracker(file);
        t.ctx.startViewerTimeTracking('outside');
        t.advance(7000);
        t.document.visibilityState = 'hidden';
        t.events.visibilitychange();
        t.advance(120000);
        await t.ctx.sendViewerTimeHeartbeat();
        assert.equal(t.requests.at(-1).p_duration_seconds, 7);
        t.document.visibilityState = 'visible';
        t.events.visibilitychange();
        t.advance(3000);
        await t.ctx.sendViewerTimeHeartbeat();
        assert.equal(t.requests.at(-1).p_duration_seconds, 10);
    });

    test(file + ': leaving and returning through browser history starts a new visit', () => {
        const t = tracker(file);
        t.ctx.startViewerTimeTracking('outside');
        const firstVisit = t.requests[0].p_visit_id;
        t.advance(5000);
        t.events.pagehide();
        assert.equal(t.requests.at(-1).p_ended, true);
        assert.equal(t.timers.size, 0);
        t.advance(60000);
        t.ctx.libraryViewActive = true;
        t.events.pageshow({ persisted: true });
        assert.notEqual(t.requests.at(-1).p_visit_id, firstVisit);
        assert.equal(t.requests.at(-1).p_duration_seconds, 0);
        assert.equal(t.requests.at(-1).p_context, 'library');
        assert.equal(t.timers.size, 1);
    });
}

const admin = read('admin.html');
function adminContext(extra = {}) {
    const ctx = vm.createContext(extra);
    vm.runInContext(['formatWatchTime', 'formatViewerSessionAverage', 'renderViewerSessionRows'].map(name => extract(admin, name)).join('\n'), ctx);
    return ctx;
}

test('Admin shows each user average, including valid zero-duration visits and missing history', () => {
    const ctx = adminContext();
    assert.equal(ctx.formatViewerSessionAverage({ session_count: 2, average_session_seconds: 75 }), '1m 15s');
    assert.equal(ctx.formatViewerSessionAverage({ session_count: 2, average_session_seconds: 75, estimated_session_count: 1 }), '~ 1m 15s');
    assert.equal(ctx.formatViewerSessionAverage({ session_count: 1, average_session_seconds: 0 }), '0s');
    assert.equal(ctx.formatViewerSessionAverage({ session_count: 0, average_session_seconds: null }), 'No sessions yet');
});

function element(tag) {
    return {
        tag, dataset: {}, style: {}, children: [], textContent: '', disabled: false,
        appendChild(child) { this.children.push(child); },
        replaceChildren() { this.children = []; },
        set innerHTML(_) { assert.fail('Viewer identity must render as plain text'); }
    };
}
test('Admin renders separate metrics for each user, with safe identity text and platform labels', () => {
    const list = element('tbody');
    const ctx = adminContext({ document: { getElementById: () => list, createElement: element } });
    ctx.renderViewerSessionRows([
        { viewer_id: '<img src=x onerror=alert(1)>', platforms: ['website'], session_count: 2, average_session_seconds: 75, total_session_seconds: 150 },
        { viewer_id: 'second-user', platforms: ['mini_app'], session_count: 1, average_session_seconds: 92, total_session_seconds: 92, estimated_session_count: 1 }
    ]);
    assert.equal(list.children.length, 2);
    assert.deepEqual(list.children[0].children.map(c => c.textContent), ['User <img src=x onerror=alert(1)>', 'Website', '1m 15s', '2', '2m 30s']);
    assert.deepEqual(list.children[1].children.map(c => c.textContent), ['User second-user', 'Mini App', '~ 1m 32s', '1', '1m 32s']);
});

test('Admin does not render a pending metrics response after logout', async () => {
    const nodes = new Map();
    const get = id => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); };
    get('app').style.display = 'block';
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const ctx = vm.createContext({
        document: { getElementById: get },
        requireStreamXAdminSession: async () => ({ user: { id: 'admin' } }),
        supabaseClient: { rpc: async () => response },
        renderViewerSessionRows() { assert.fail('Response after logout must not render'); }
    });
    vm.runInContext('let viewerSessionLoading = false, viewerSessionOffset = 0, viewerSessionTotal = 0, streamXVerifiedAdminUserId = "admin"; const VIEWER_SESSION_PAGE_SIZE = 50;\nasync ' + extract(admin, 'loadViewerSessionStatistics'), ctx);
    const pending = ctx.loadViewerSessionStatistics();
    await Promise.resolve();
    get('app').style.display = 'none';
    vm.runInContext('streamXVerifiedAdminUserId = null;', ctx);
    finish({ data: { total: 1, users: [{ viewer_id: 'viewer' }] } });
    await pending;
});
