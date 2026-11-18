// Precompress build output so the server can serve .br / .gz (ServeDir precompressed_*).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const root = new URL("../dist/", import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
let n = 0;
for (const f of walk(root)) {
  if (!/\.(js|css|html|svg|json|map)$/.test(f)) continue;
  const buf = readFileSync(f);
  if (buf.length < 1024) continue;
  writeFileSync(f + ".gz", gzipSync(buf, { level: 9 }));
  writeFileSync(f + ".br", brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  n++;
}
console.log(`precompressed ${n} files`);
