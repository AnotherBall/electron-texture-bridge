// Stub module for vitest on platforms without native .node binary.
// All tests use vi.mock() factory mocks, so this stub is never actually called.
module.exports.TextureSender = undefined;
module.exports.TextureReceiver = undefined;
module.exports.closeNativeHandle = undefined;
module.exports.getPlatform = undefined;
module.exports.listSenders = undefined;
