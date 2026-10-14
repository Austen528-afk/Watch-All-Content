const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const pages = ["index.html", "telegram.html"];

function sourceOf(file) {
    return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

function functionSource(source, name) {
    const start = source.indexOf("function " + name + "(");
    const tail = source.slice(start);
    const closing = tail.match(/\r?\n\}/);
    assert.ok(start >= 0 && closing, name + " source range");
    return tail.slice(0, closing.index + closing[0].length);
}

test("recommendation order stays fixed after the viewer starts browsing", () => {
    for (const page of pages) {
        const source = sourceOf(page);
        const feedOrderState = source.match(
            /let feedOrderRecommendations = null;\s*let feedRecommendationOrderLocked = false;/
        );
        assert.ok(feedOrderState, page + " declares feed-order state");
        const lockSource = functionSource(
            source,
            "lockFeedRecommendationOrder"
        );
        const activeSource = functionSource(
            source,
            "getActiveFeedRecommendations"
        );
        const context = vm.createContext({
            recommendationVideos: [{ id: 1 }],
        });
        vm.runInContext(feedOrderState[0] + lockSource + activeSource, context, {
            filename: page + "-feed-order.js",
        });

        context.lockFeedRecommendationOrder();
        context.recommendationVideos = [{ id: 2 }];

        assert.deepEqual(
            Array.from(context.getActiveFeedRecommendations(), row => row.id),
            [1],
            page
        );
        assert.match(source, /const activeRecommendations = getActiveFeedRecommendations\(\)/, page);
    }
});

test("Telegram infinite scrolling appends only the newly revealed cards", () => {
    const source = sourceOf("telegram.html");
    const renderSource = functionSource(source, "renderVideos");
    const cards = Array.from({ length: 20 }, (_, id) => ({ id }));
    const existingCards = cards.slice(0, 10).map(({ id }) => ({ id }));
    let gridWasCleared = false;
    const context = vm.createContext({
        updateCategoryNavigation() {},
        getVideosForDisplay: () => cards,
        getFeedRenderKey: () => "main-feed",
        feedRenderKey: "main-feed",
        feedVisibleCount: 20,
        FEED_BATCH_SIZE: 10,
        feedLoadSentinel: {},
        videoGrid: {
            nodes: existingCards,
            set innerHTML(value) {
                if (value === "") {
                    gridWasCleared = true;
                    this.nodes = [];
                }
            },
            appendChild(fragment) {
                this.nodes.push(...fragment.children);
            },
        },
        searchTerm: "",
        libraryViewActive: false,
        currentCategory: "All",
        sectionTitle: {},
        searchStatus: { style: {} },
        resultCount: {},
        document: {
            createDocumentFragment: () => ({
                children: [],
                appendChild(card) { this.children.push(card); },
            }),
        },
        createVideoCard: video => ({ id: video.id }),
        updateFeedLoadStatus() {},
        setupTelegramVideoPreviewWindow() {},
        setupFeedThumbnailWindow() {},
        setupInfiniteFeedObserver() {},
        scheduleHlsLibraryPreload() {},
        scheduleVideoURLPrefetch() {},
        scheduleVideoByteWarm() {},
    });
    vm.runInContext(renderSource, context, {
        filename: "telegram-feed-render.js",
    });

    context.renderVideos({ appendFromIndex: 10 });

    assert.equal(gridWasCleared, false);
    assert.deepEqual(
        Array.from(context.videoGrid.nodes, card => card.id),
        Array.from({ length: 20 }, (_, id) => id)
    );
    assert.match(source, /renderVideos\(\{\s*appendFromIndex:previousVisibleCount\s*\}\)/);
    assert.match(source, /observedFeedKey !== feedRenderKey/);
});
