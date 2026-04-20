const Module = require("module");

function loadModuleWithMocks(modulePath, mocks = {}) {
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[require.resolve(modulePath)];

    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

module.exports = { loadModuleWithMocks };
