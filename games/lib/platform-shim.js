/**
 * 4399 platform API shim.
 *
 * The game cores were built for the 4399 hosting platform, which injects a
 * global `h5api` object into the page. The bundles call `h5api.progress(...)`
 * from the asset-loader's per-file completion callback (games 1-4); when the
 * game is self-hosted nobody defines it, so every file completion throws a
 * ReferenceError. Chromium's loader timing happens to absorb that; on
 * Firefox the exception escapes through the image onload path, aborts the
 * load queue and the game stalls forever on a black screen.
 *
 * This shim provides the missing platform object with no-op stand-ins so
 * the game hosts identically anywhere. It must load BEFORE the game bundle
 * (see index.html script order). If a real platform integration ever needs
 * to provide actual h5api behaviour, it can define window.h5api first —
 * the shim then stays out of the way.
 */
(function () {
    'use strict';

    if (typeof window.h5api !== 'undefined') return;

    var noop = function () {};

    // Explicitly provide what the bundles call; a Proxy covers any other
    // platform method a future code path might touch.
    window.h5api = new Proxy(
        { progress: noop },
        {
            get: function (target, prop) {
                if (prop in target) return target[prop];
                return noop;
            },
        },
    );
})();
