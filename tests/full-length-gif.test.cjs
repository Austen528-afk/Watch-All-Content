const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const pages = ["index.html", "telegram.html"];

function sourceOf(file) {
    return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

function makeImage(url, { complete = false, naturalWidth = 0 } = {}) {
    let src = "";
    const listeners = new Map();
    const classes = new Set();
    const status = { textContent: "Loading animation…" };
    const previewClasses = new Set(["streamx-preview-ready"]);
    const preview = {
        paused: false,
        pause() { this.paused = true; },
        classList: { remove: name => previewClasses.delete(name) },
    };
    const thumbnail = {
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
        },
        querySelector: selector => selector === ".thumbnail-preview-video" ? preview : status,
    };
    return {
        dataset: { gifSrc: url, gifState: "" },
        isConnected: true,
        assignments: 0,
        fetchPriority: "",
        loading: "",
        complete,
        naturalWidth,
        currentSrc: url,
        listeners,
        classes,
        status,
        preview,
        previewClasses,
        addEventListener(name, listener) { listeners.set(name, listener); },
        closest() { return thumbnail; },
        decode() { throw new Error("decode() must not block GIF display"); },
        fire(name) { listeners.get(name)?.(); },
        set src(value) { src = value; this.assignments += 1; },
        get src() { return src; },
        getAttribute(name) { return name === "src" ? src : null; },
        getBoundingClientRect() {
            return { top: 0, bottom: 120, left: 0, right: 300 };
        }
    };
}

function runQueueHarness(page, width) {
    const source = sourceOf(page);
    const start = source.indexOf("const streamxGifLoadQueue = new Map();");
    const end = source.indexOf("function canPreloadFeedThumbnails()", start);
    assert.ok(start >= 0 && end > start, page + " GIF queue helpers");
    const images = [makeImage("one.gif"), makeImage("two.gif"), makeImage("three.gif")];
    const context = {
        navigator: { connection: { effectiveType: "4g" }, deviceMemory: 8 },
        window: { innerWidth: width, innerHeight: 800, setTimeout: () => 1, clearTimeout() {} },
        document: { documentElement: { clientHeight: 800 } },
        canLoadFeedThumbnails: () => true,
        streamxFeedPreviewPlaybackSuspended: false,
        scheduleFeedThumbnailWindow() {},
        Set, Map, Array, Number, Promise
    };
    vm.createContext(context);
    const exercise = [
        source.slice(start, end),
        "streamxGifDesired = new Set(images);",
        "images.forEach(image => requestFeedGif(image, 'high'));",
        "globalThis.initialAssignments = images.map(image => image.assignments);",
        "globalThis.activeCount = streamxGifActiveRequests.size;",
        "requestFeedGif(images[0], 'high');",
        "globalThis.repeatAssignments = images[0].assignments;",
        "images[0].dataset.gifState = 'loaded';",
        "streamxGifActiveRequests.delete(images[0]);",
        "pumpFeedGifQueue();",
        "globalThis.afterScrollAssignments = images[0].assignments;",
        "globalThis.nextStarted = images[1].assignments;"
    ].join("\n");
    context.images = images;
    vm.runInContext(exercise, context, { filename: page + "-gif-queue.js" });
    return context;
}

test("website and Telegram render full GIFs above a retained static poster", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        assert.match(source, /class="thumbnail-gif-preview"/, page);
        assert.match(source, /class="thumbnail-gif-status"/, page);
        assert.match(source, /thumbnail\.streamx-gif-ready \.thumbnail-gif-preview\{opacity:1;\}/, page);
        assert.match(source, /image\.addEventListener\("load"/, page);
        assert.match(source, /markFeedGifReady\(image\)/, page);
        assert.doesNotMatch(source, /image\.decode\(\)/, page + " must not gate display on decode()");
        assert.match(source, /gif_preview_url/, page);
        assert.match(source, /const previewVideoURL = video\.preview_video_url/, page);
        assert.match(source, /thumbnail\.streamx-gif-ready \.thumbnail-preview-video\{opacity:0;\}/, page);
        assert.match(source, /streamx-preview-active/, page);
    }
});

test("a loaded full GIF appears without waiting for WebView decode()", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const start = source.indexOf("const streamxGifLoadQueue = new Map();");
        const end = source.indexOf("function canPreloadFeedThumbnails()", start);
        const image = makeImage("https://media.example/full.gif");
        image.src = image.dataset.gifSrc;
        const context = {
            navigator: { connection: { effectiveType: "4g" }, deviceMemory: 8 },
            window: { innerWidth: 390, innerHeight: 800, setTimeout: () => 1, clearTimeout() {} },
            document: { visibilityState: "visible", documentElement: { clientHeight: 800 } },
            videoGrid: { querySelectorAll: () => [image] },
            streamxFeedPreviewPlaybackSuspended: false,
            scheduleFeedThumbnailWindow() {},
            Set, Map, WeakMap, Array, Number, Promise,
        };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end), context, { filename: page + "-gif-display.js" });
        context.trackFeedGifPreviews();
        image.complete = true;
        image.naturalWidth = 640;
        image.classes.add("streamx-preview-active");
        image.fire("load");
        assert.equal(image.dataset.gifState, "loaded", page);
        assert.equal(image.classes.has("streamx-gif-ready"), true, page);
        assert.equal(image.classes.has("streamx-preview-active"), false, page + " full GIF replaces the teaser");
        assert.equal(image.preview.paused, true, page + " pauses the teaser after the full GIF loads");
        assert.equal(image.previewClasses.has("streamx-preview-ready"), false, page + " hides the teaser");
        assert.equal(image.status.textContent, "", page + " clears its loading label when ready");
    }
});

test("the worker builds a ten-second low-bandwidth teaser without changing GIF duration", () => {
    const worker = sourceOf("worker.mjs");
    const configStart = worker.indexOf("const PREVIEW_DURATION_SECONDS");
    const configEnd = worker.indexOf("const PREVIEW_MAX_WIDTH", configStart);
    const previewStart = worker.indexOf("async function createLightweightPreview(");
    const previewEnd = worker.indexOf("async function createStaticPoster(", previewStart);
    assert.ok(configStart >= 0 && configEnd > configStart && previewEnd > previewStart);
    const config = worker.slice(configStart, configEnd);
    const preview = worker.slice(previewStart, previewEnd);
    assert.match(config, /Math\.min\(\s*10,\s*Number\(process\.env\.PREVIEW_DURATION_SECONDS \|\| 10\)\s*\)/);
    assert.match(preview, /fps=10/);
    assert.match(preview, /"-maxrate", "160k"/);
    assert.match(preview, /"-bufsize", "320k"/);
});

test("an already-complete cached GIF is recovered when the WebView restores the feed", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const start = source.indexOf("const streamxGifLoadQueue = new Map();");
        const end = source.indexOf("function canPreloadFeedThumbnails()", start);
        const image = makeImage("https://media.example/cached.gif", { complete: true, naturalWidth: 480 });
        image.src = image.dataset.gifSrc;
        const context = {
            navigator: { connection: { effectiveType: "4g" }, deviceMemory: 8 },
            window: { innerWidth: 390, innerHeight: 800, setTimeout: () => 1, clearTimeout() {} },
            document: { visibilityState: "visible", documentElement: { clientHeight: 800 } },
            videoGrid: { querySelectorAll: () => [image] },
            streamxFeedPreviewPlaybackSuspended: false,
            scheduleFeedThumbnailWindow() {},
            Set, Map, WeakMap, Array, Number, Promise,
        };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end), context, { filename: page + "-gif-restore.js" });
        context.trackFeedGifPreviews();
        assert.equal(image.dataset.gifState, "loaded", page);
        assert.equal(image.classes.has("streamx-gif-ready"), true, page);
    }
});

test("a slow full GIF gets a clear loading state, then recovers when its load completes", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const start = source.indexOf("const streamxGifLoadQueue = new Map();");
        const end = source.indexOf("function canPreloadFeedThumbnails()", start);
        const timers = new Map();
        let nextTimer = 0;
        const image = makeImage("https://media.example/large-full.gif");
        image.src = image.dataset.gifSrc;
        const context = {
            navigator: { connection: { effectiveType: "4g" }, deviceMemory: 8 },
            window: {
                innerWidth: 390,
                innerHeight: 800,
                setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
                clearTimeout(id) { timers.delete(id); },
            },
            document: { visibilityState: "visible", documentElement: { clientHeight: 800 } },
            videoGrid: { querySelectorAll: () => [image] },
            streamxFeedPreviewPlaybackSuspended: false,
            scheduleFeedThumbnailWindow() {},
            Set, Map, WeakMap, Array, Number, Promise,
        };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end), context, { filename: page + "-gif-slow-load.js" });
        context.trackFeedGifPreviews();
        context.testGifImage = image;
        vm.runInContext("streamxGifDesired = new Set([testGifImage]);", context);
        context.requestFeedGif(image, "high");
        const notice = [...timers.entries()].find(([, timer]) => timer.delay === 12000);
        assert.ok(notice, page + " starts a visible load watchdog");
        timers.delete(notice[0]);
        notice[1].callback();
        assert.equal(image.status.textContent, "Large animation is still loading…", page);

        image.complete = true;
        image.naturalWidth = 640;
        image.fire("load");
        assert.equal(image.dataset.gifState, "loaded", page);
        assert.equal(image.classes.has("streamx-gif-ready"), true, page);
        assert.equal(timers.size, 0, page + " clears the watchdog when the full file loads");
    }
});

test("opening playback does not cancel or reset an in-flight GIF image", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        if (page === "index.html") {
            const start = source.indexOf("function stopUnfinishedFeedPreviewRequests(){");
            const end = source.indexOf("function getFeedPreviewWindow", start);
            const body = source.slice(start, end);
            assert.ok(start >= 0 && end > start, "website player request stop function");
            assert.match(body, /\.thumbnail-fallback/);
            assert.doesNotMatch(body, /thumbnail-gif-preview/);
            assert.doesNotMatch(body, /gifSrc/);
        } else {
            const start = source.indexOf("function suspendFeedGif(image){");
            const end = source.indexOf("function activateFeedGif(image)", start);
            const body = source.slice(start, end);
            assert.ok(start >= 0 && end > start, "Telegram preview suspension");
            assert.doesNotMatch(body, /removeAttribute\(["']src/);
            assert.doesNotMatch(body, /gifSrc/);
        }
    }
});

test("visible GIF downloads are bounded and repeated visibility calls keep the same src", () => {
    for (const page of pages) {
        const mobile = runQueueHarness(page, 390);
        assert.equal(mobile.activeCount, 1, page + " mobile concurrency");
        assert.deepEqual(mobile.initialAssignments, [1, 0, 0], page + " mobile queue");
        assert.equal(mobile.repeatAssignments, 1, page + " repeated request");
        assert.equal(mobile.afterScrollAssignments, 1, page + " source retained");
        assert.equal(mobile.nextStarted, 1, page + " advances after load");

        const desktop = runQueueHarness(page, 1200);
        assert.equal(desktop.activeCount, 2, page + " desktop concurrency");
        assert.deepEqual(desktop.initialAssignments, [1, 1, 0], page + " desktop queue");
    }
});
