// Service-facing content-coding exports. The computation lives in
// @red-cup-engineering/computing-with-http/codecs/compression.

export {
  CODINGS,
  compress,
  compressStream,
  decompress,
  decompressStream,
  supportedCompressionCodings,
  zstdSupported,
} from "@red-cup-engineering/computing-with-http/codecs/compression";
