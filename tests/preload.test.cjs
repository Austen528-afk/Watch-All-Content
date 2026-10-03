const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function extract(source, name) {
    const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

function clock() {
    let now = 0, next = 0;
    const jobs = new Map();
    return {
        now: () => now,
        setTimeout(fn, delay = 0) { const id = ++next; jobs.set(id, { fn, at: now + delay }); return id; },
        clearTimeout(id) { jobs.delete(id); },
        advance(ms) {
            const end = now + ms;
            for (let i = 0; i < 1000; i++) {
                const due = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                jobs.delete(due[0]); now = due[1].at; due[1].fn();
            }
            now = end;
        },
    };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const bytes = () => new Uint8Array([1, 2, 3, 4]).buffer;

function harness(source) {
    const time = clock(), requests = [], normalLoads = [], cards = [];
    const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3100000\n720p/index.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=950000\n360p/index.m3u8\n';
    const playlist = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:2\n' +
        Array.from({ length: 10 }, (_, i) => '#EXTINF:2,\nsegment' + i + '.ts\n').join('') + '#EXT-X-ENDLIST\n';
    class NormalLoader {
        constructor() { this.stats = { loading: {}, parsing: {}, buffering: {}, aborted: false }; }
        load(context, config, callbacks) { normalLoads.push({ context, config, callbacks }); }
        abort() { this.stats.aborted = true; }
        destroy() {}
    }
    const context = {
        ArrayBuffer, TextEncoder, AbortController, URL, performance: { now: time.now },
        Date: { now: time.now }, console,
        navigator: { connection: { effectiveType: '4g' } },
        document: { visibilityState: 'visible', documentElement: { clientHeight: 800, clientWidth: 390 } },
        videoModal: { classList: { contains: () => false } },
        window: { innerHeight: 800, innerWidth: 390, scrollY: 0, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout },
        videoGrid: { querySelectorAll: () => cards },
        videoByteWarmCache: new Set(), videoByteWarmPromiseCache: new Map(), videoByteWarmControllers: new Map(),
        videoByteWarmCandidates: [], videoByteWarmScheduleId: 0, videoByteWarmTimer: null, videoByteWarmWindowKey: '',
        VIDEO_BYTE_WARM_TIMEOUT_MS: 4500,
        getVideoURL: async video => video.video_url,
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.signal.aborted) throw new Error('aborted');
            return { ok: true, url, headers: { get: () => null },
                text: async () => url.endsWith('master.m3u8') ? manifest : playlist,
                arrayBuffer: async () => bytes() };
        },
    };
    for (let i = 0; i < 25; i++) {
        const card = { streamxPlaybackVideo: { id: i, video_url: 'https://media.example/' + i + '/master.m3u8' },
            querySelector() { return this; },
            getBoundingClientRect() { const top = i * 1000 - context.window.scrollY; return { top, bottom: top + 900, left: 0, right: 390 }; } };
        cards.push(card);
    }
    vm.createContext(context);
    const cache = source.slice(source.indexOf('const HLS_OPENING_CACHE_TTL_MS'), source.indexOf('function shouldUseNativeHLSPlayback'));
    vm.runInContext(cache + '\n' + ['getVideoWarmCacheKey', 'isHLSVideoURL', 'shouldWarmVideoBytes', 'cancelVideoByteWarming',
        'warmVideoBytes', 'getFeedVideoByteWarmCandidates', 'getVideoByteWarmPlan', 'scheduleVideoByteWarm'].map(name => extract(source, name)).join('\n'), context);
    vm.runInContext('this.inspect = { cache:hlsOpeningCache, pending:hlsOpeningRequests, bytes:() => hlsOpeningCacheBytes };', context);
    const Loader = context.createOpeningHlsLoader({ DefaultConfig: { loader: NormalLoader } });
    return { context, time, requests, normalLoads, cards, Loader, NormalLoader, playlist };
}

async function load(h, url, type = 'text') {
    const loader = new h.Loader({});
    const result = new Promise(resolve => loader.load({ url, responseType: type }, {}, { onSuccess: (response, stats) => resolve({ response, stats }) }));
    await flush();
    return result;
}

for (const filename of ['index.html', 'telegram.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8').replace(/\r\n/g, '\n');

    test(filename + ': all inline scripts parse', () => {
        for (const [, attrs, script] of source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
            if (!/\bsrc\s*=/.test(attrs)) new vm.Script(script, { filename });
        }
    });

    test(filename + ': opening preload chooses lowest quality and only opening seconds', async () => {
        const h = harness(source), video = h.cards[0].streamxPlaybackVideo;
        assert.equal(await h.context.warmHlsVideoStart(video.video_url, h.context.getVideoWarmCacheKey(video)), true);
        assert.deepEqual(h.requests.map(r => r.url), [video.video_url,
            'https://media.example/0/360p/index.m3u8', 'https://media.example/0/360p/segment0.ts']);
        assert.ok(h.requests.every(r => r.options.priority === 'low'));
        assert.equal(h.context.videoByteWarmControllers.size, 0);
    });

    test(filename + ': player reuses prepared manifest, playlist and segment without requests', async () => {
        const h = harness(source), video = h.cards[0].streamxPlaybackVideo;
        await h.context.warmVideoBytes(video);
        const requestCount = h.requests.length;
        await load(h, video.video_url);
        await load(h, 'https://media.example/0/360p/index.m3u8');
        const url = 'https://media.example/0/360p/segment0.ts';
        const first = await load(h, url, 'arraybuffer');
        assert.deepEqual(new Uint8Array(first.response.data), new Uint8Array([1, 2, 3, 4]));
        structuredClone(first.response.data, { transfer: [first.response.data] });
        const second = await load(h, url, 'arraybuffer');
        assert.equal(second.response.data.byteLength, 4, 'Worker transfer must not detach the reusable cache');
        assert.equal(h.requests.length, requestCount);
        assert.equal(h.normalLoads.length, 0);
        assert.ok(second.stats.loading.end > second.stats.loading.first, 'Memory hits must not imply infinite bandwidth');
    });

    test(filename + ': scrolling keeps ten ahead and follows recommendation order', () => {
        const h = harness(source);
        assert.deepEqual(Array.from(h.context.getFeedVideoByteWarmCandidates(), v => v.id), Array.from({ length: 11 }, (_, i) => i));
        h.context.window.scrollY = 1000;
        assert.deepEqual(Array.from(h.context.getFeedVideoByteWarmCandidates(), v => v.id), Array.from({ length: 11 }, (_, i) => i + 1));
        [h.cards[1], h.cards[20]] = [h.cards[20], h.cards[1]];
        h.cards.forEach((card, i) => { card.getBoundingClientRect = () => ({ top: i * 1000 - 1000, bottom: i * 1000 - 100, left: 0, right: 390 }); });
        assert.equal(h.context.getFeedVideoByteWarmCandidates()[0].id, 20);
        h.cards.splice(4);
        assert.equal(h.context.getFeedVideoByteWarmCandidates().length, 3, 'Queue stops at the rendered feed end');
    });

    test(filename + ': background warming stays serial and viewport callbacks do not reset it', async () => {
        const h = harness(source), started = [], releases = [];
        let active = 0, maxActive = 0;
        h.context.warmVideoBytes = async video => {
            started.push(video.id); active++; maxActive = Math.max(maxActive, active);
            const key = h.context.getVideoWarmCacheKey(video);
            const promise = new Promise(resolve => releases.push(resolve));
            h.context.videoByteWarmPromiseCache.set(key, promise);
            await promise; active--;
            h.context.videoByteWarmPromiseCache.delete(key); h.context.videoByteWarmCache.add(key);
        };
        h.context.scheduleVideoByteWarm();
        for (let i = 0; i < 5; i++) h.context.scheduleVideoByteWarm();
        h.time.advance(500); await flush();
        assert.deepEqual(started, [0]);
        h.time.advance(1000); await flush();
        assert.deepEqual(started, [0], 'Pending warm-up owns the one background slot');
        for (let i = 0; i < 11; i++) {
            releases.shift()(); await flush(); h.time.advance(100); await flush();
        }
        assert.deepEqual(started, Array.from({ length: 11 }, (_, i) => i));
        assert.equal(maxActive, 1);
        h.context.window.scrollY = 1000; h.context.scheduleVideoByteWarm(); h.time.advance(500); await flush();
        assert.equal(started.at(-1), 11, 'Advancing one card prepares only the newly added tenth video');
        releases.shift()(); await flush();
    });

    test(filename + ': modal, hidden page, Save Data and 2G suppress speculative downloads', async () => {
        for (const mode of ['modal', 'hidden', 'saveData', '2g']) {
            const h = harness(source);
            if (mode === 'modal') h.context.videoModal.classList.contains = () => true;
            if (mode === 'hidden') h.context.document.visibilityState = 'hidden';
            if (mode === 'saveData') h.context.navigator.connection.saveData = true;
            if (mode === '2g') h.context.navigator.connection.effectiveType = '2g';
            h.context.scheduleVideoByteWarm(); h.time.advance(1000); await flush();
            assert.equal(h.requests.length, 0, mode);
        }
        const h = harness(source);
        h.context.hasPendingFeedThumbnails = () => true;
        assert.equal(h.context.shouldWarmVideoBytes(), true, 'Full GIF completion must not starve opening preloads');
    });

    test(filename + ': direct hover intent moves preparation ahead of the paint delay', async () => {
        const h = harness(source), started = [];
        h.context.warmVideoBytes = async video => { started.push(video.id); };
        h.context.scheduleVideoByteWarm();
        h.context.scheduleVideoByteWarm(h.cards[0].streamxPlaybackVideo);
        h.time.advance(0); await flush();
        assert.deepEqual(started, [0]);
    });

    test(filename + ': HLS playback uses prepared bytes and keeps adaptive quality; native HLS and MP4 still attach', async () => {
        const h = harness(source), created = [];
        class FakeHls {
            static DefaultConfig = { loader: h.NormalLoader };
            static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
            static ErrorTypes = {};
            static isSupported() { return true; }
            constructor(config) { this.config = config; this.events = {}; created.push(this); }
            on(event, callback) { this.events[event] = callback; }
            loadSource(url) { this.url = url; this.events.manifest(); }
            attachMedia(media) { this.media = media; }
        }
        h.context.playerVideo = { src: '', load() {} };
        h.context.activeHlsPlayer = null;
        h.context.destroyActiveHlsPlayer = () => {};
        h.context.ensureHlsLibrary = async () => FakeHls;
        h.context.shouldUseNativeHLSPlayback = () => false;
        vm.runInContext(extract(source, 'attachVideoSource'), h.context);
        const video = h.cards[0].streamxPlaybackVideo;
        await h.context.warmVideoBytes(video);
        await h.context.attachVideoSource(video.video_url);
        assert.equal(created.length, 1);
        assert.equal(created[0].config.startLevel, 0);
        assert.equal(created[0].config.startFragPrefetch, true);
        assert.equal(created[0].url, video.video_url);
        assert.equal(created[0].media, h.context.playerVideo);
        let data;
        new created[0].config.loader({}).load({ url: video.video_url, responseType: 'text' }, {}, {
            onSuccess(response) { data = response.data; },
        });
        await flush();
        assert.ok(data.startsWith('#EXTM3U'));
        assert.equal(h.normalLoads.length, 0);
        h.context.shouldUseNativeHLSPlayback = () => true;
        await h.context.attachVideoSource(video.video_url);
        assert.equal(created.length, 1);
        assert.equal(h.context.playerVideo.src, video.video_url);
        await h.context.attachVideoSource('https://media.example/video.mp4');
        assert.equal(h.context.playerVideo.src, 'https://media.example/video.mp4');
    });

    test(filename + ': tapping preserves only the selected video warm-up', () => {
        const h = harness(source), selected = h.cards[0].streamxPlaybackVideo, other = h.cards[1].streamxPlaybackVideo;
        const keep = new AbortController(), cancel = new AbortController();
        h.context.videoByteWarmControllers.set(h.context.getVideoWarmCacheKey(selected), keep);
        h.context.videoByteWarmControllers.set(h.context.getVideoWarmCacheKey(other), cancel);
        h.context.cancelVideoByteWarming(selected);
        assert.equal(keep.signal.aborted, false);
        assert.equal(cancel.signal.aborted, true);
        assert.equal(h.context.videoByteWarmWindowKey, '');
    });

    test(filename + ': pending opening data is reused, but a slow preload falls back promptly', async () => {
        const h = harness(source), url = 'https://media.example/pending.ts';
        let resolve;
        h.context.inspect.pending.set(url, new Promise(done => { resolve = done; }));
        const result = load(h, url, 'arraybuffer');
        resolve({ url, data: bytes(), size: 4 });
        assert.equal((await result).response.data.byteLength, 4);
        assert.equal(h.normalLoads.length, 0);
        h.context.inspect.pending.set(url, new Promise(() => {}));
        const loader = new h.Loader({});
        loader.load({ url, responseType: 'arraybuffer' }, {}, { onSuccess() { assert.fail('Still pending'); } });
        h.time.advance(350); await flush();
        assert.equal(h.normalLoads.length, 1);
    });

    test(filename + ': loader misses, range requests and aborts preserve normal playback behavior', async () => {
        const h = harness(source), url = 'https://media.example/segment.ts';
        new h.Loader({}).load({ url, responseType: 'arraybuffer' }, {}, {});
        assert.equal(h.normalLoads.length, 1);
        h.context.rememberHlsOpeningResponse(url, { url, data: bytes(), size: 4 }, 'video');
        new h.Loader({}).load({ url, responseType: 'arraybuffer', rangeStart: 0, rangeEnd: 2 }, {}, {});
        assert.equal(h.normalLoads.length, 2);
        let called = false;
        const loader = new h.Loader({});
        loader.load({ url, responseType: 'arraybuffer' }, {}, { onSuccess() { called = true; } });
        loader.abort(); await flush();
        assert.equal(called, false, 'Closed players must not receive cached callbacks');
    });

    test(filename + ': cache is bounded, expires and allows rewarming after eviction', async () => {
        const h = harness(source);
        const size = 2 * 1024 * 1024;
        for (let i = 0; i < 7; i++) {
            const url = 'https://media.example/' + i + '.ts';
            h.context.videoByteWarmCache.add(String(i));
            h.context.rememberHlsOpeningResponse(url, { url, data: bytes(), size }, String(i));
        }
        assert.equal(h.context.inspect.bytes(), 12 * 1024 * 1024);
        assert.equal(h.context.videoByteWarmCache.has('0'), false);
        assert.equal(h.context.getHlsOpeningResponse('https://media.example/0.ts'), null);
        h.time.advance(600001);
        assert.equal(h.context.getHlsOpeningResponse('https://media.example/6.ts'), null);
        assert.equal(h.context.videoByteWarmCache.has('6'), false);
    });

    test(filename + ': live, encrypted and range playlists do not cache or download segments', async () => {
        for (const mode of ['live', 'encrypted', 'range']) {
            const h = harness(source), url = h.cards[0].streamxPlaybackVideo.video_url;
            const playlist = mode === 'live' ? h.playlist.replace('#EXT-X-ENDLIST', '') :
                '#EXTM3U\n' + (mode === 'encrypted' ? '#EXT-X-KEY:METHOD=AES-128,URI="key"\n' : '#EXT-X-BYTERANGE:4@0\n') +
                '#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST';
            h.context.fetch = async requestURL => {
                h.requests.push({ url: requestURL });
                return { ok: true, url: requestURL, text: async () => playlist };
            };
            assert.equal(await h.context.warmHlsVideoStart(url, 'v'), false);
            assert.equal(h.requests.length, 1);
            assert.equal(h.context.inspect.cache.size, 0);
        }
    });
}
