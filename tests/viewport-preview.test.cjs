const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extract(name) {
    const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('upcoming cards request posters without starting their MP4 previews', () => {
    const requests = [], image = {}, preview = {};
    const ctx = vm.createContext({
        requestFeedThumbnail: (image, priority) => requests.push({ image, priority }),
        prepareFeedVideoPreview: preview => requests.push({ preview })
    });
    vm.runInContext(extract('requestFeedCardPreview'), ctx);
    const card = { querySelector: selector => selector === '.thumbnail-fallback' ? image : preview };
    ctx.requestFeedCardPreview(card, 'low');
    assert.deepEqual(requests, [{ image, priority: 'low' }]);
    ctx.requestFeedCardPreview(card, 'high');
    assert.equal(requests.length, 3);
    assert.equal(requests[2].preview, preview);
});

test('a stale visibility callback cannot request an offscreen MP4', () => {
    const ctx = vm.createContext({
        canLoadFeedThumbnails: () => true,
        window: { innerHeight: 800, innerWidth: 390 },
        document: { documentElement: {} },
        scheduleFeedThumbnailWindow() {}
    });
    vm.runInContext(extract('prepareFeedVideoPreview'), ctx);
    for (const rect of [
        { top: 900, bottom: 1200, left: 0, right: 300 },
        { top: -300, bottom: -1, left: 0, right: 300 },
        { top: 0, bottom: 300, left: 500, right: 700 }
    ]) {
        const video = {
            dataset: { previewSrc: 'https://media.example/preview.mp4' },
            getBoundingClientRect: () => rect,
            load() { assert.fail('Offscreen preview requested'); }
        };
        ctx.prepareFeedVideoPreview(video);
        assert.equal(video.src, undefined);
        assert.equal(video.dataset.streamxPreviewPrepared, undefined);
    }
    let loads = 0;
    const visible = {
        dataset: { previewSrc: 'https://media.example/preview.mp4', streamxPreviewTracked: '1' },
        getBoundingClientRect: () => ({ top: 0, bottom: 300, left: 0, right: 300 }),
        load() { loads++; }
    };
    ctx.prepareFeedVideoPreview(visible);
    assert.equal(loads, 1);
    assert.equal(visible.src, visible.dataset.previewSrc);
    ctx.prepareFeedVideoPreview(visible);
    assert.equal(loads, 1, 'Scroll callbacks must not restart a prepared preview');
});
