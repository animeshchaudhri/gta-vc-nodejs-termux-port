(function() {
    var moduleVersion = '20260424-1';
    var modules = [
        'modules/runtime.js',
        (currentLanguage === 'ru' ? 'modules/packages/ru.js' : 'modules/packages/en.js'),
        'modules/loader.js',
        'modules/fs.js',
        'modules/audio.js',
        'modules/graphics.js',
        'modules/events.js',
        'modules/fetch.js',
        (currentLanguage === 'ru' ? 'modules/asm_consts/ru.js' : 'modules/asm_consts/en.js'),
        // 'modules/cheats.js',
        'modules/main.js'
    ];

    if (cheatsEnabled)
        modules.push('modules/cheats.js');

    var modulesWithVersion = modules.map(function(modulePath) {
        return modulePath + '?v=' + moduleVersion;
    });

    if (typeof importScripts === 'function') {
        importScripts.apply(null, modulesWithVersion);
    } else {
        var loadNext = function(i) {
            if (i < modulesWithVersion.length) {
                var s = document.createElement('script');
                s.src = modulesWithVersion[i];
                s.async = false; // Ensure order
                s.onload = function() { loadNext(i + 1); };
                s.onerror = function() { console.error('Failed to load module: ' + modulesWithVersion[i]); };
                document.body.appendChild(s);
            }
        };
        loadNext(0);
    }
})();
