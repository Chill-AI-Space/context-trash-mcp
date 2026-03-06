import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { logError } from '../logger.js';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'compress-on-input');

const MIN_MEANINGFUL_CHARS = 7;

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return __dirname;
}

function getSwiftSourcePath(): string {
  const root = findPackageRoot();
  const candidates = [
    path.join(root, 'src', 'ocr', 'vision.swift'),
    path.join(root, 'ocr', 'vision.swift'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function getSourceHash(): string {
  const srcPath = getSwiftSourcePath();
  if (!fs.existsSync(srcPath)) return '';
  const content = fs.readFileSync(srcPath);
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

function ensureVisionBinary(): string | null {
  if (process.platform !== 'darwin') return null;

  const hash = getSourceHash();
  const versionedBin = path.join(CACHE_DIR, `vision-ocr-${hash}`);

  if (fs.existsSync(versionedBin)) return versionedBin;

  const srcPath = getSwiftSourcePath();
  if (!fs.existsSync(srcPath)) return null;

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    execFileSync('swiftc', ['-O', '-o', versionedBin, srcPath], {
      timeout: 30000,
    });
    return versionedBin;
  } catch (err) {
    logError(`Failed to compile Vision OCR: ${err}`);
    return null;
  }
}

function runVisionOCR(imagePath: string): string | null {
  const bin = ensureVisionBinary();
  if (!bin) return null;

  try {
    const result = execFileSync(bin, [imagePath], { timeout: 10000 });
    return result.toString('utf-8');
  } catch (err) {
    logError(`Vision OCR failed: ${err}`);
    return null;
  }
}

function runTesseractOCR(imagePath: string): string | null {
  try {
    const result = execFileSync('tesseract', [imagePath, 'stdout'], {
      timeout: 10000,
    });
    return result.toString('utf-8');
  } catch (err) {
    logError(`Tesseract OCR failed: ${err}`);
    return null;
  }
}

export function compressOCR(
  block: ContentBlock,
  engine: 'auto' | 'vision' | 'tesseract',
): ContentBlock {
  if (block.type !== 'image' || !block.data) {
    return block;
  }

  const tmpFile = path.join(os.tmpdir(), `coi-${Date.now()}.png`);
  try {
    const buffer = Buffer.from(block.data, 'base64');
    fs.writeFileSync(tmpFile, buffer);

    let text: string | null = null;

    if (engine === 'vision' || (engine === 'auto' && process.platform === 'darwin')) {
      text = runVisionOCR(tmpFile);
    }

    if (!text && (engine === 'tesseract' || engine === 'auto')) {
      text = runTesseractOCR(tmpFile);
    }

    if (!text) return block;

    // Quality check: fewer than MIN_MEANINGFUL_CHARS non-whitespace chars → passthrough
    const meaningfulChars = text.replace(/\s/g, '').length;
    if (meaningfulChars < MIN_MEANINGFUL_CHARS) {
      return block;
    }

    return {
      type: 'text',
      text: `[OCR extracted from screenshot — may contain errors]\n${text.trim()}`,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
