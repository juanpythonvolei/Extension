import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export interface TarEntry {
  /** Relative path inside archive, e.g. "./usr/bin/continuum" */
  name: string;
  content: string | Buffer;
  mode?: number;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  buf.write(str.slice(0, length), offset, length, 'ascii');
}

function makeTarHeader(name: string, size: number, mode: number, isDir: boolean, mtime: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid root
  writeOctal(header, 116, 8, 0); // gid root
  writeOctal(header, 124, 12, isDir ? 0 : size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156); // checksum placeholder
  header[156] = isDir ? 0x35 : 0x30; // '5' dir, '0' file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const chkStr = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(chkStr, 148, 8, 'ascii');
  return header;
}

function buildTarGz(entries: TarEntry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  const createdDirs = new Set<string>(['./']);

  chunks.push(makeTarHeader('./', 0, 0o755, true, mtime));

  for (const entry of entries) {
    const normalized = entry.name.startsWith('./') ? entry.name : `./${entry.name.replace(/^\/+/, '')}`;
    const parts = normalized.split('/');
    for (let i = 2; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/') + '/';
      if (!createdDirs.has(dirPath)) {
        createdDirs.add(dirPath);
        chunks.push(makeTarHeader(dirPath, 0, 0o755, true, mtime));
      }
    }

    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const mode = entry.mode ?? 0o644;
    chunks.push(makeTarHeader(normalized, data.length, mode, false, mtime));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }

  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 6 });
}

function makeArMember(name: string, data: Buffer): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const headerStr =
    name.padEnd(16, ' ').slice(0, 16) +
    String(mtime).padEnd(12, ' ').slice(0, 12) +
    '0     ' + // owner id (6)
    '0     ' + // group id (6)
    '100644  ' + // mode (8)
    String(data.length).padEnd(10, ' ').slice(0, 10) +
    '`\n';
  const headerBuf = Buffer.from(headerStr, 'ascii');
  if (data.length % 2 === 1) {
    return Buffer.concat([headerBuf, data, Buffer.from('\n', 'ascii')]);
  }
  return Buffer.concat([headerBuf, data]);
}

function buildMd5Sums(dataEntries: TarEntry[]): string {
  const lines: string[] = [];
  for (const entry of dataEntries) {
    const rel = entry.name.replace(/^\.?\//, '');
    const buf = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    lines.push(`${hash}  ${rel}`);
  }
  return lines.join('\n') + '\n';
}

function tryBuildWithSystemDpkgDeb(controlEntries: TarEntry[], dataEntries: TarEntry[]): Buffer | null {
  if (!fs.existsSync('/usr/bin/dpkg-deb')) return null;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-deb-'));
  const stageDir = path.join(tmpRoot, 'pkg');
  const debianDir = path.join(stageDir, 'DEBIAN');
  const outDeb = path.join(tmpRoot, 'continuum.deb');

  try {
    fs.mkdirSync(debianDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(stageDir, 0o755);
    fs.chmodSync(debianDir, 0o755);

    for (const entry of controlEntries) {
      const cleanName = entry.name.replace(/^\.?\//, '');
      const dest = path.join(debianDir, cleanName);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
      fs.writeFileSync(dest, data);
      fs.chmodSync(dest, entry.mode ?? 0o644);
    }

    for (const entry of dataEntries) {
      const cleanName = entry.name.replace(/^\.?\//, '');
      const dest = path.join(stageDir, cleanName);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
      fs.writeFileSync(dest, data);
      fs.chmodSync(dest, entry.mode ?? 0o644);
    }

    execFileSync('/usr/bin/dpkg-deb', ['--root-owner-group', '-Zgzip', '--build', stageDir, outDeb], {
      stdio: 'pipe',
      timeout: 15000,
    });

    return fs.readFileSync(outDeb);
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Builds a standards-compliant Debian/Ubuntu/Zorin OS `.deb` binary package.
 * Uses native `/usr/bin/dpkg-deb --root-owner-group` when available (100% genuine Debian toolchain),
 * with an RFC/POSIX `ar` + `ustar` pure-Node fallback, always including `DEBIAN/md5sums`.
 */
export function buildDebPackage(controlEntries: TarEntry[], dataEntries: TarEntry[]): Buffer {
  const hasMd5 = controlEntries.some((e) => e.name.replace(/^\.?\//, '') === 'md5sums');
  const fullControlEntries: TarEntry[] = hasMd5
    ? controlEntries
    : [...controlEntries, { name: './md5sums', content: buildMd5Sums(dataEntries), mode: 0o644 }];

  const nativeDeb = tryBuildWithSystemDpkgDeb(fullControlEntries, dataEntries);
  if (nativeDeb && nativeDeb.subarray(0, 8).toString('ascii') === '!<arch>\n') {
    return nativeDeb;
  }

  const magic = Buffer.from('!<arch>\n', 'ascii');
  const debianBinary = Buffer.from('2.0\n', 'ascii');
  const controlTarGz = buildTarGz(fullControlEntries);
  const dataTarGz = buildTarGz(dataEntries);

  return Buffer.concat([
    magic,
    makeArMember('debian-binary', debianBinary),
    makeArMember('control.tar.gz', controlTarGz),
    makeArMember('data.tar.gz', dataTarGz),
  ]);
}
