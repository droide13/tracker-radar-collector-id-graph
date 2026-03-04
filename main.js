const crawlerConductor = require('./crawlerConductor');
const crawler = require('./crawler');

const RequestCollector = require('./collectors/RequestCollector');
const APICallCollector = require('./collectors/APICallCollector');
const CookieCollector = require('./collectors/CookieCollector');
const TargetCollector = require('./collectors/TargetCollector');
const TraceCollector = require('./collectors/TraceCollector');
const ScreenshotCollector = require('./collectors/ScreenshotCollector');
const CookiePopupsCollector = require('./collectors/CookiePopupsCollector');

// NEW
const EmailFillCollector = require('./collectors/emailFillCollector');
const HarCollector = require('./collectors/harCollector');

// reexport main pieces of code so that they can be easily imported when this project is used as a dependency
// e.g. `const {crawlerConductor} = require('3p-crawler');`
module.exports = {
    crawler,
    crawlerConductor,
    // collectors ↓
    RequestCollector,
    APICallCollector,
    CookieCollector,
    TargetCollector,
    TraceCollector,
    ScreenshotCollector,
    CookiePopupsCollector,

    // NEW collectors
    EmailFillCollector,
    HarCollector,
};
