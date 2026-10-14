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
    };
    vm.createContext(context);
    vm.runInContext(
        source.slice(start, end) +
            "\nglobalThis.previewSelection = {gifPreviewURL,gifSizeBytes,previewVideoURL,thumbnail};",
        context,
        { filename: page + "-preview-selection.js" }
    );
    return context.previewSelection;
}

test("both feeds default to the short MP4 preview and ignore generated GIFs", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            preview_video_url: "https://media.example/first-ten-seconds.mp4",
            gif_preview_url: "https://media.example/automatic-full.gif",
            gif_teaser_url: "https://media.example/automatic-teaser.gif",
            gif_size_bytes: 800000,
        });

        assert.equal(selected.gifPreviewURL, "", page);
        assert.equal(selected.previewVideoURL, "https://media.example/first-ten-seconds.mp4", page);
        assert.equal(selected.thumbnail, "https://media.example/poster.jpg", page);

        const source = sourceOf(page);
        assert.match(source, /class="thumbnail-preview-video"/, page);
        assert.match(source, /data-preview-src="\$\{escapeHTML\(previewVideoURL\)\}"/, page);
        assert.doesNotMatch(source, /syncRecentFeedGifMetadataPolling\(\);/, page);
    }
});

test("an admin-supplied GIF overrides the MP4 only for that post", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/poster.jpg",
            preview_video_url: "https://media.example/preview.mp4",
            admin_gif_url: "https://media.example/admin-preview.gif",
            admin_gif_size_bytes: 1.2 * 1024 * 1024,
            gif_preview_url: "https://media.example/automatic-full.gif",
            gif_teaser_url: "https://media.example/automatic-teaser.gif",
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/admin-preview.gif", page);
        assert.equal(selected.gifSizeBytes, 1.2 * 1024 * 1024, page);
        assert.equal(selected.previewVideoURL, "https://media.example/preview.mp4", page);
    }
});

test("oversized admin GIFs fall back to the short video preview", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "poster.jpg",
            preview_video_url: "preview.mp4",
            admin_gif_url: "too-large.gif",
            admin_gif_size_bytes: 6 * 1024 * 1024,
        });

        assert.equal(selected.gifPreviewURL, "", page);
        assert.equal(selected.previewVideoURL, "preview.mp4", page);
    }
});

test("legacy admin GIF thumbnails remain eligible after the migration", () => {
    for (const page of pages) {
        const selected = previewSelectionFor(page, {
            thumbnail_url: "https://media.example/legacy-admin.gif",
            preview_video_url: "preview.mp4",
            gif_size_bytes: 2 * 1024 * 1024,
        });

        assert.equal(selected.gifPreviewURL, "https://media.example/legacy-admin.gif", page);
        assert.equal(selected.thumbnail, "", page);
    }
});

test("GIF failure releases the short video preview fallback", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const start = source.indexOf("function feedCardGifOwnsPreview(video){");
        const end = source.indexOf("function ", start + 12);
        assert.ok(start >= 0 && end > start, page + " GIF preview ownership helper");

        const context = {};
        vm.createContext(context);
        vm.runInContext(
            source.slice(start, end) +
                "\nglobalThis.ownsPreview = feedCardGifOwnsPreview;",
            context,
            { filename: page + "-gif-preview-ownership.js" }
        );

        const image = { dataset: { gifSrc: "preview.gif", gifState: "loading" } };
        const thumbnail = { querySelector: () => image };
        const video = { closest: () => thumbnail };
        assert.equal(context.ownsPreview(video), true, page);
        image.dataset.gifState = "failed";
        assert.equal(context.ownsPreview(video), false, page);

        assert.match(source, /if\(preview\)\{[\s\S]*?play(?:Feed|Thumbnail)VideoPreview\(preview\)/, page);
    }
});

test("feed GIF loading still prioritizes visible posts and pauses for the player", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const start = source.indexOf("function canLoadFeedThumbnails(){");
        const end = source.indexOf("function canPreloadFeedThumbnails(){", start);
        assert.ok(start >= 0 && end > start, page + " GIF load gate");

        const canLoad = ({ visibility, modalOpen }) => {
            const context = {
                document: { visibilityState: visibility },
                videoModal: {
                    classList: { contains: name => name === "show" && modalOpen },
                },
            };
            vm.createContext(context);
            vm.runInContext(source.slice(start, end), context, {
                filename: page + "-gif-load-gate.js",
            });
            return context.canLoadFeedThumbnails();
        };

        assert.equal(canLoad({ visibility: "visible", modalOpen: false }), true, page);
        assert.equal(canLoad({ visibility: "visible", modalOpen: true }), false, page);
        assert.equal(canLoad({ visibility: "hidden", modalOpen: false }), false, page);
    }
});

test("admin has an optional per-post GIF upload and no automatic GIF batch queue", () => {
    const admin = sourceOf("admin.html");
    assert.match(admin, /id="adminGifFile" accept="image\/gif,\.gif"/);
    assert.match(admin, /admin_gif_url:\s*adminGifURL/);
    assert.match(admin, /admin_gif_size_bytes:\s*selectedAdminGifFile\s*\?\s*selectedAdminGifFile\.size\s*:\s*null/);
    assert.match(admin, /selectedAdminGifFile\.size > maxBytes/);
    assert.doesNotMatch(admin, /optimizeAllGifPreviews|queue_streamx_feed_gif_processing|Generate Missing 5s GIF Previews/);
    assert.doesNotMatch(admin, /Full-Length GIF Management|gifManagementRows|gif-management-panel/);
});

test("schema keeps a separate admin GIF override and backfills old admin GIF thumbnails", () => {
    const migration = sourceOf("supabase/migrations/20261014220449_admin_gif_preview_override.sql");
    assert.match(migration, /add column if not exists admin_gif_url text/);
    assert.match(migration, /add column if not exists admin_gif_size_bytes bigint/);
    assert.match(migration, /thumbnail_url ~\* '\\.gif\(\[\?\#\]\|\$\)'/);
});
