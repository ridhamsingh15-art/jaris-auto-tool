import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';

const ROOT_DIR = process.cwd();
const EXT_DIR = path.join(ROOT_DIR, 'public', 'extension');
const ICONS_DIR = path.join(EXT_DIR, 'icons');

/**
 * Generates a valid RGBA PNG buffer of size width x height with a dark slate background
 * (#0B0F17), sky-blue geometric border (#0284C7), and emerald status center (#16A34A).
 */
function createIconPngBuffer(size) {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0; // No filter
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      const border = Math.max(1, Math.floor(size * 0.12));
      const innerMin = Math.floor(size * 0.32);
      const innerMax = Math.ceil(size * 0.68);

      const isOuterBorder =
        x < border || x >= width - border || y < border || y >= height - border;
      const isCenterCore =
        x >= innerMin && x < innerMax && y >= innerMin && y < innerMax;

      if (isOuterBorder) {
        // Sky blue accent (#0284C7)
        rawData[px] = 2;
        rawData[px + 1] = 132;
        rawData[px + 2] = 199;
        rawData[px + 3] = 255;
      } else if (isCenterCore) {
        // Nominal emerald (#16A34A)
        rawData[px] = 22;
        rawData[px + 1] = 163;
        rawData[px + 2] = 74;
        rawData[px + 3] = 255;
      } else {
        // Deep dark slate (#0B0F17)
        rawData[px] = 11;
        rawData[px + 1] = 15;
        rawData[px + 2] = 23;
        rawData[px + 3] = 255;
      }
    }
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

async function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  for (const size of [16, 48, 128]) {
    const iconPath = path.join(ICONS_DIR, `icon${size}.png`);
    fs.writeFileSync(iconPath, createIconPngBuffer(size));
  }

  // Copy README.md to workspace root as well
  const extReadme = path.join(EXT_DIR, 'README.md');
  if (fs.existsSync(extReadme)) {
    fs.copyFileSync(extReadme, path.join(ROOT_DIR, 'README.md'));
  }

  // Copy canonical tests/extension.test.js into public/extension/tests/ so the exported ZIP includes tests/
  const extTestsDir = path.join(EXT_DIR, 'tests');
  fs.mkdirSync(extTestsDir, { recursive: true });
  const rootTestFile = path.join(ROOT_DIR, 'tests', 'extension.test.js');
  if (fs.existsSync(rootTestFile)) {
    fs.copyFileSync(rootTestFile, path.join(extTestsDir, 'extension.test.js'));
  }

  // Build root-level ZIP archive where manifest.json is at the root of the archive
  const zip = new JSZip();

  function addDirectoryToZip(dirPath, zipFolder) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        addDirectoryToZip(fullPath, zipFolder.folder(entry.name));
      } else {
        const content = fs.readFileSync(fullPath);
        zipFolder.file(entry.name, content);
      }
    }
  }

  addDirectoryToZip(EXT_DIR, zip);

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  const outZipPath = path.join(ROOT_DIR, 'public', 'jarvis-autopilot-mv3-extension.zip');
  fs.writeFileSync(outZipPath, zipBuffer);
  console.log(`[JARVIS Packaging] Generated icons and root-level MV3 archive: ${outZipPath} (${zipBuffer.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
