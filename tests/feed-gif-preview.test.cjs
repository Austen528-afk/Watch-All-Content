const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const pages = ["index.html", "telegram.html"];

function sourceOf(file) {
    return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

function previewSelectionFor(page, video) {
    const source = sourceOf(page);
    const start = source.indexOf('const rawThumbnailURL = String(video.thumbnail_url || "").trim();');
    const end = source.indexOf("const title =", start);
    assert.ok(start >= 0 && end > start, page + " preview source selection");

    const context = {
        video,
        getPublicURL: value => value || "",
        shouldWaitForRecentFeedGif: () => false,
    };
    vm.createContext(context);
    vm.runInContext(
        source.slice(start, end) +
            "\nglobalThis.previewSelection = {gifPreviewURL,gifSizeBytes,gifPreviewExpected};",
        context,
        { filename: page + "-preview-selection.js" }
    );
    return context.previewSelection;
}

test("both feeds choose a compact GIF teaser before a full GIF", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            gif_preview_url: "https://media.example/full.gif",
            gif_size_bytes: 54 * 1024 * 1024,
            gif_teaser_url: "https://media.example/feed-preview.gif",
            gif_teaser_size_bytes: 780000,
            gif_teaser_duration_seconds: 5,
            preview_video_url: "https://media.example/preview.mp4",
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/feed-preview.gif", page);
        assert.equal(selected.gifSizeBytes, 780000, page);
        assert.equal(selected.gifPreviewExpected, true, page);
    }
});

test("both feeds allow a higher-quality teaser up to three MiB", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            gif_teaser_url: "https://media.example/feed-preview.gif",
            gif_teaser_size_bytes: 2.5 * 1024 * 1024,
            gif_teaser_duration_seconds: 5,
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/feed-preview.gif", page);
        assert.equal(selected.gifSizeBytes, 2.5 * 1024 * 1024, page);
    }
});

test("both feeds avoid starting a large full GIF when no teaser exists", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            gif_preview_url: "https://media.example/full.gif",
            gif_size_bytes: 54 * 1024 * 1024,
            gif_teaser_url: "",
            gif_teaser_size_bytes: 0,
            gif_teaser_duration_seconds: 0,
            preview_video_url: "https://media.example/preview.mp4",
        });

        assert.equal(selected.gifPreviewURL, "", page);
        assert.equal(selected.gifPreviewExpected, true, page);
    }
});

test("both feeds retain small legacy GIF fallback and five-second teaser loading", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            gif_preview_url: "https://media.example/legacy.gif",
            gif_size_bytes: 3 * 1024 * 1024,
            gif_teaser_url: "",
            gif_teaser_size_bytes: 0,
            gif_teaser_duration_seconds: 0,
            preview_video_url: "",
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/legacy.gif", page);
        assert.equal(selected.gifSizeBytes, 3 * 1024 * 1024, page);
        assert.match(source, /data-gif-src="\$\{escapeHTML\(gifPreviewURL\)\}"/, page);
    }
});

test("both feeds reject teasers longer than five seconds", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            gif_preview_url: "https://media.example/full.gif",
            gif_size_bytes: 740000,
            gif_teaser_url: "https://media.example/ten-second-preview.gif",
            gif_teaser_size_bytes: 900000,
            gif_teaser_duration_seconds: 10,
        });

        assert.equal(selected.gifPreviewURL, "", page);
        assert.equal(selected.gifPreviewExpected, true, page);
    }
});

test("both feeds never render the MP4 source as a thumbnail preview", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        assert.doesNotMatch(source, /class=["']thumbnail-preview-video["']/ , page);
        assert.doesNotMatch(source, /data-preview-src=/, page);
        assert.match(source, /data-gif-src="\$\{escapeHTML\(gifPreviewURL\)\}"/, page);
    }
});

test("admin no longer exposes full-length GIF batch or regeneration controls", () => {
    const admin = sourceOf("admin.html");
    assert.doesNotMatch(admin, /Full-Length GIF Management|gifManagementRows|gif-management-panel/);
    assert.doesNotMatch(admin, /queueStreamXGif|regenerateStreamXGif|replaceVideoGif/);
    assert.doesNotMatch(admin, /\/admin\/queue-gif|\/admin\/gif-estimate|gifQueued/);
});

test("admin repair queues missing and overlong teasers while retaining valid previews", () => {
    const admin = sourceOf("admin.html");
    const start = admin.indexOf("function hasUsableFeedGifPreview(video){");
    const end = admin.indexOf("function setOptimizeAllGifButtonBusy(", start);
    assert.ok(start >= 0 && end > start, "admin feed GIF repair predicate");
    const context = {};
    vm.createContext(context);
    vm.runInContext(
        admin.slice(start, end) +
            "globalThis.needsRepair = needsFeedGifPreviewGeneration;",
        context,
        { filename: "admin-gif-repair-predicate.js" }
    );

    assert.equal(context.needsRepair({ source_video_url: "source.mp4" }), true);
    assert.equal(context.needsRepair({
        source_video_url: "source.mp4",
        gif_teaser_url: "ten-seconds.gif",
        gif_teaser_size_bytes: 900000,
        gif_teaser_duration_seconds: 10,
        gif_preview_url: "small-full.gif",
        gif_size_bytes: 740000,
    }), true);
    assert.equal(context.needsRepair({
        source_video_url: "source.mp4",
        gif_teaser_url: "five-seconds.gif",
        gif_teaser_size_bytes: 900000,
        gif_teaser_duration_seconds: 5,
    }), false);
    assert.equal(context.needsRepair({
        source_video_url: "source.mp4",
        gif_teaser_url: "higher-quality-five-seconds.gif",
        gif_teaser_size_bytes: 2.5 * 1024 * 1024,
        gif_teaser_duration_seconds: 5,
    }), false);
    assert.equal(context.needsRepair({
        source_video_url: "source.mp4",
        gif_preview_url: "small-legacy.gif",
        gif_size_bytes: 3 * 1024 * 1024,
    }), false);
    assert.equal(context.needsRepair({ gif_teaser_url: "no-source.gif" }), false);

    const batch = admin.slice(admin.indexOf("async function optimizeAllGifPreviews(){"));
    assert.match(batch, /queue_streamx_feed_gif_processing/);
    assert.doesNotMatch(batch, /queue_streamx_poster_processing|queue_streamx_preview_processing/);
    assert.match(batch, /Generate the missing five-second feed GIF previews/);
    assert.match(batch, /Each GIF uses up to five seconds of video and is capped at 3 MiB/);
});

test("feed GIF queue RPC can refresh static JPG posters", () => {
    const migration = sourceOf(
        "supabase/migrations/20261014200000_queue_feed_gif_previews.sql"
    );
    assert.match(migration, /queue_streamx_feed_gif_processing\\s*\\(\\s*p_video_id bigint\\s*\\)/);
    assert.match(migration, /public\\.is_streamx_admin\\(\\)/);
    assert.match(migration, /processing_type[\\s\\S]*?'poster'/);
    assert.doesNotMatch(migration, /thumbnail_value[\\s\\S]*?not like '%\\.gif'/);
});
