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
            preview_video_url: "https://media.example/preview.mp4",
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/feed-preview.gif", page);
        assert.equal(selected.gifSizeBytes, 780000, page);
        assert.equal(selected.gifPreviewExpected, true, page);
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
            preview_video_url: "",
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/legacy.gif", page);
        assert.equal(selected.gifSizeBytes, 3 * 1024 * 1024, page);
        assert.match(source, /data-gif-src=\"\$\{escapeHTML\(gifPreviewURL\)\}\"/, page);
    }
});

test("both feeds never render MP4 preview video elements", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        assert.doesNotMatch(source, /class="thumbnail-preview-video"/, page);
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
