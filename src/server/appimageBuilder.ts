import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FOOTER_MAGIC = Buffer.from('CONT_APPIMG_V1\0\0', 'ascii'); // 16 bytes
const RUNTIME_BIN_PATH = path.resolve(__dirname, 'assets/appimage-runtime-x86_64.bin');
const RUNTIME_SRC_PATH = path.resolve(__dirname, 'appimageRuntime.c');

export interface AppDirEntry {
  path: string;
  content: Buffer | string;
  mode?: number;
}

let cachedRuntimeBinary: Buffer | null = null;

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, '0');
  buf.write(str.slice(-(length - 1)), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function buildTarHeader(name: string, size: number, mode: number, typeFlag: '0' | '5'): Buffer {
  const header = Buffer.alloc(512, 0);
  const cleanName = name.replace(/^\.?\//, '');
  let fileName = cleanName;
  let prefix = '';

  if (Buffer.byteLength(cleanName, 'utf8') > 100) {
    const slashIdx = cleanName.lastIndexOf('/');
    if (slashIdx > 0) {
      prefix = cleanName.slice(0, slashIdx);
      fileName = cleanName.slice(slashIdx + 1);
    }
  }

  header.write(fileName.slice(0, 100), 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header.write(typeFlag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  if (prefix) {
    header.write(prefix.slice(0, 155), 345, 155, 'utf8');
  }

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const chkStr = checksum.toString(8).padStart(6, '0');
  header.write(chkStr, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTarGzBuffer(entries: AppDirEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const createdDirs = new Set<string>();

  const ensureDir = (dirPath: string) => {
    const clean = dirPath.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!clean) return;
    const parts = clean.split('/');
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!createdDirs.has(acc)) {
        createdDirs.add(acc);
        chunks.push(buildTarHeader(`${acc}/`, 0, 0o755, '5'));
      }
    }
  };

  for (const entry of entries) {
    const cleanPath = entry.path.replace(/^\.?\//, '');
    const slashIdx = cleanPath.lastIndexOf('/');
    if (slashIdx > 0) {
      ensureDir(cleanPath.slice(0, slashIdx));
    }
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const mode = entry.mode ?? 0o644;
    chunks.push(buildTarHeader(cleanPath, data.length, mode, '0'));
    chunks.push(data);
    const rem = data.length % 512;
    if (rem !== 0) {
      chunks.push(Buffer.alloc(512 - rem, 0));
    }
  }

  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function loadAppImageRuntime(): Buffer {
  if (cachedRuntimeBinary) return cachedRuntimeBinary;

  if (fs.existsSync(RUNTIME_BIN_PATH)) {
    const bin = fs.readFileSync(RUNTIME_BIN_PATH);
    if (bin.length > 4096 && bin[0] === 0x7f && bin[1] === 0x45 && bin[2] === 0x4c && bin[3] === 0x46) {
      cachedRuntimeBinary = bin;
      return bin;
    }
  }

  // Fallback: compile on demand if gcc is available
  fs.mkdirSync(path.dirname(RUNTIME_BIN_PATH), { recursive: true });
  execFileSync('gcc', ['-O2', '-s', '-static', RUNTIME_SRC_PATH, '-o', RUNTIME_BIN_PATH], {
    stdio: 'pipe',
  });
  cachedRuntimeBinary = fs.readFileSync(RUNTIME_BIN_PATH);
  return cachedRuntimeBinary;
}

/**
 * Builds a genuine, self-contained x86_64 Linux ELF .AppImage executable
 * (Zero-FUSE: runs directly on Zorin OS, Ubuntu 20-24, Mint, Debian, Fedora, Arch).
 */
export function buildAppImageBinary(appDirEntries: AppDirEntry[]): Buffer {
  const runtime = loadAppImageRuntime();
  const payload = buildTarGzBuffer(appDirEntries);

  const footer = Buffer.alloc(32);
  FOOTER_MAGIC.copy(footer, 0);
  footer.writeBigUInt64LE(BigInt(runtime.length), 16);
  footer.writeBigUInt64LE(BigInt(payload.length), 24);

  return Buffer.concat([runtime, payload, footer]);
}
