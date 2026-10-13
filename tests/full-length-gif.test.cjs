const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const pages = ["index.html", "telegram.html"];

function sourceOf(file) {
    return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

function makeImage(url) {
    let src = "";
    return {
        dataset: { gifSrc: url, gifState: "" },
        isConnected: true,
        assignments: 0,
        fetchPriority: "",
        loading: "",
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
    const end = source.indexOf("function queueFeedGifPreviews(", start);
    assert.ok(start >= 0 && end > start, page + " GIF queue helpers");
    const images = [makeImage("one.gif"), makeImage("two.gif"), makeImage("three.gif")];
    const context = {
        navigator: { connection: { effectiveType: "4g" }, deviceMemory: 8 },
        window: { innerWidth: width, innerHeight: 800 },
        document: { documentElement: { clientHeight: 800 } },
        canLoadFeedThumbnails: () => true,
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
        assert.match(source, /image\.decode\(\)/, page);
        assert.match(source, /STREAMX_GIF_DECODE_TIMEOUT_MS/, page);
        assert.match(source, /gif_preview_url/, page);
        assert.match(source, /!gifPreviewURL && video\.preview_video_url/, page);
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
