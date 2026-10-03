const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Exercise the pinned SDK's actual loader/fragment lifecycle. Only the network
// transport and unused retry/logging dependencies are controlled by the test.
function upstream(name) {
    const source = fs.readFileSync(path.join(__dirname, 'vendor', 'hls.js-v1.7.3', name + '.ts'), 'utf8');
    return stripTypeScriptTypes(source, { mode: 'transform' })
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/\bexport default /g, '')
        .replace(/^export /gm, '');
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const bytes = () => new Uint8Array([1, 2, 3, 4]).buffer;

function harness(source) {
    const requests = [], errors = [], timers = new Map();
    let timerId = 0, now = 1000;
    const scope = { ArrayBuffer, Promise, console, TextEncoder, Date,
        performance: { now: () => now },
        videoByteWarmCache: new Set(),
        logger: { warn() {}, error() {} },
        shouldRetry: () => false, getRetryDelay: () => 0,
        getLoaderConfigWithoutReties: policy => ({ ...policy, errorRetry: null, timeoutRetry: null }),
        ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' },
        ErrorDetails: { INTERNAL_ABORTED: 'internalAborted', FRAG_LOAD_ERROR: 'fragLoadError', FRAG_LOAD_TIMEOUT: 'fragLoadTimeout', FRAG_GAP: 'fragGap' },
        LoaderContextType: { MEDIA_FRAGMENT: 'media-fragment' },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    class TestXHR {
        constructor() { this.readyState = 0; this.status = 0; this.responseType = ''; }
        open(method, url) { this.readyState = 1; this.url = url; }
        setRequestHeader() {}
        getAllResponseHeaders() { return ''; }
        getResponseHeader() { return null; }
        abort() { this.readyState = 0; }
        send() {
            requests.push(this.url);
            Promise.resolve().then(() => {
                if (!this.onreadystatechange) return;
                now += 10;
                this.readyState = 4; this.status = 200; this.responseURL = this.url;
                this.response = bytes();
                try { this.onreadystatechange(); } catch (error) { errors.push(error); }
            });
        }
    }
    scope.XMLHttpRequest = TestXHR;
    scope.self = scope.window = scope;
    vm.createContext(scope);
    for (const name of ['load-stats', 'base-loader', 'xhr-loader', 'fragment-loader']) vm.runInContext(upstream(name), scope, { filename: 'hls.js-v1.7.3/' + name });
    const cache = source.slice(source.indexOf('const HLS_OPENING_CACHE_TTL_MS'), source.indexOf('async function warmHlsVideoStart'));
    vm.runInContext(cache + '\nthis.SDK = { XhrLoader, FragmentLoader, LoadStats }; this.cache = hlsOpeningCache;', scope);
    const Loader = scope.createOpeningHlsLoader({ DefaultConfig: { loader: scope.SDK.XhrLoader } });
    const fragments = new scope.SDK.FragmentLoader({ loader: Loader,
        fragLoadPolicy: { default: { maxTimeToFirstByteMs: 1000, maxLoadTimeMs: 10000 } } });
    const fragment = index => ({ sn: index, url: 'https://media.example/segment' + index + '.ts',
        type: 'main', level: 0, duration: 2, gap: false, tagList: [], decryptdata: null, stats: new scope.SDK.LoadStats() });
    const prepare = index => {
        const url = 'https://media.example/segment' + index + '.ts';
        scope.rememberHlsOpeningResponse(url, { url, data: bytes(), size: 4 }, 'video');
    };
    return { scope, Loader, fragments, fragment, prepare, requests, errors, timers };
}

async function completion(h, frag, progress) {
    const result = { state: 'pending' };
    h.fragments.load(frag, false, progress).then(value => { result.state = 'resolved'; result.value = value; }, error => { result.state = 'rejected'; result.error = error; });
    await flush();
    return result;
}

for (const filename of ['index.html', 'telegram.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8').replace(/\r\n/g, '\n');

    test(filename + ': SDK receives cached bytes through progress before successful completion', async () => {
        const h = harness(source); h.prepare(0);
        const progress = [], frag = h.fragment(0);
        const result = await completion(h, frag, data => { ++data.frag.stats.chunkCount; progress.push(data.payload); });
        assert.equal(result.state, 'resolved');
        assert.equal(progress.length, 1, 'Prepared bytes must reach the transmuxer progress path');
        assert.equal(progress[0].byteLength, 4);
        assert.equal(frag.stats.chunkCount, 1, 'HLS owns the progressive chunk count');
        assert.equal(h.requests.length, 0);
        assert.equal(h.errors.length, 0);
    });

    test(filename + ': SDK completes ten consecutive segments after the cached opening', async () => {
        const h = harness(source); h.prepare(0);
        const delivered = [], completed = [];
        for (let i = 0; i < 10; i++) {
            const frag = h.fragment(i);
            const result = await completion(h, frag, data => { ++data.frag.stats.chunkCount; delivered.push(data.frag.sn); });
            assert.equal(h.errors.length, 0, 'Successful cleanup must not recursively abort');
            assert.equal(result.state, 'resolved', 'Segment ' + i + ' must complete successfully');
            assert.equal(frag.stats.aborted, false);
            assert.equal(frag.stats.chunkCount, 1);
            completed.push(result.value.frag.sn);
        }
        assert.deepEqual(delivered, Array.from({ length: 10 }, (_, i) => i));
        assert.deepEqual(completed, delivered);
        assert.equal(h.requests.length, 9, 'Only the nine unprepared segments use the normal XHR loader');
        assert.equal(h.timers.size, 0);
    });

    test(filename + ': cold normal segments finish without emitting an abort during destruction', async () => {
        const h = harness(source), frag = h.fragment(0);
        const result = await completion(h, frag, data => ++data.frag.stats.chunkCount);
        assert.equal(h.errors.length, 0);
        assert.equal(result.state, 'resolved');
        assert.equal(frag.stats.aborted, false);
        assert.equal(h.requests.length, 1);
    });

    test(filename + ': cancelling cached and pending SDK loads settles their promises', async () => {
        for (const mode of ['cached', 'pending']) {
            const h = harness(source), frag = h.fragment(0);
            if (mode === 'cached') h.prepare(0);
            else vm.runInContext('hlsOpeningRequests.set("https://media.example/segment0.ts", new Promise(() => {}));', h.scope);
            const result = { state: 'pending' };
            h.fragments.load(frag, false, () => assert.fail('Cancelled payload')).then(() => { result.state = 'resolved'; }, error => { result.state = 'rejected'; result.error = error; });
            h.fragments.abort(); await flush();
            assert.equal(result.state, 'rejected', mode);
            assert.equal(result.error.data.details, 'internalAborted');
            assert.equal(h.errors.length, 0);
            assert.equal(h.timers.size, 0);
        }
    });

    test(filename + ': cancelling while cached progress is delivered prevents successful completion', async () => {
        const h = harness(source), frag = h.fragment(0);
        h.prepare(0);
        const result = await completion(h, frag, data => {
            ++data.frag.stats.chunkCount;
            h.fragments.abort();
        });
        assert.equal(result.state, 'rejected');
        assert.equal(result.error.data.details, 'internalAborted');
        assert.equal(h.errors.length, 0);
        assert.equal(h.timers.size, 0);
    });

    test(filename + ': a timed-out speculative request hands off to the normal SDK loader', async () => {
        const h = harness(source), frag = h.fragment(0);
        vm.runInContext('hlsOpeningRequests.set("https://media.example/segment0.ts", new Promise(() => {}));', h.scope);
        const result = { state: 'pending' };
        h.fragments.load(frag, false, data => ++data.frag.stats.chunkCount).then(value => {
            result.state = 'resolved'; result.value = value;
        }, error => { result.state = 'rejected'; result.error = error; });
        const fallback = [...h.timers.values()].find(timer => timer.delay === 350);
        assert.ok(fallback);
        fallback.fn(); await flush();
        assert.equal(result.state, 'resolved');
        assert.equal(h.requests.length, 1);
        assert.equal(h.errors.length, 0);
        assert.equal(h.timers.size, 0);
    });
}
