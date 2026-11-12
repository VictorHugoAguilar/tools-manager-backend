const { CacheService } = require("./cacheService");
const { loadCacheConfig } = require("./cacheConfig");

const config = loadCacheConfig();
const cache = new CacheService({ enabled: config.enabled, maxEntries: config.maxEntries });

module.exports = { cache, cacheConfig: config };
