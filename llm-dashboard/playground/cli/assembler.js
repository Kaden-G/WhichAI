'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createWriteStream } = require('node:fs');

// ===== Assembler: Writes generated files to disk =====
// Supports: repo_on_disk, filepack_json, zip

/**
 * Assembles generated files into the target output.
 * @param {Array} files - [{path, content}]
 * @param {Object} manifest - The planned manifest
 * @param {Object} config - Pipeline config
 * @returns {{outputPath: string, filesWritten: number, issues: string[]}}
 */
function assemble(files, manifest, config) {
  if (config.outputFormat === 'filepack_json') {
    return assembleFilepackJson(files, manifest, config);
  }
  if (config.outputFormat === 'zip') {
    return assembleZip(files, manifest, config);
  }
  // Default: repo_on_disk
  return assembleRepoOnDisk(files, manifest, config);
}

function assembleRepoOnDisk(files, manifest, config) {
  const outDir = path.resolve(config.outputDir);
  const issues = [];

  // Create output directory
  fs.mkdirSync(outDir, { recursive: true });

  let filesWritten = 0;
  for (const file of files) {
    if (!file.path || !file.content) {
      issues.push(`Skipped file with missing path or content: ${JSON.stringify(file).slice(0, 100)}`);
      continue;
    }

    const filePath = path.join(outDir, file.path);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
    filesWritten++;
  }

  // Manifest reconciliation: check every planned file exists and is non-empty
  if (manifest && manifest.files) {
    for (const planned of manifest.files) {
      const filePath = path.join(outDir, planned.path);
      if (!fs.existsSync(filePath)) {
        issues.push(`MISSING: planned file "${planned.path}" was not generated`);
      } else {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) {
          issues.push(`EMPTY: file "${planned.path}" exists but is 0 bytes`);
        }
      }
    }
  }

  if (config.verbose) {
    console.log(`[assembler] Wrote ${filesWritten} files to ${outDir}`);
    if (issues.length > 0) {
      console.log(`[assembler] ${issues.length} issue(s):`);
      issues.forEach(i => console.log(`  - ${i}`));
    }
  }

  return { outputPath: outDir, filesWritten, issues };
}

function assembleFilepackJson(files, manifest, config) {
  const outPath = config.outputDir
    ? path.resolve(config.outputDir, 'filepack.json')
    : path.resolve('filepack.json');

  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });

  const pack = {
    version: 1,
    generatedAt: new Date().toISOString(),
    manifest: manifest,
    files: files.map(f => ({ path: f.path, content: f.content })),
  };

  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2), 'utf-8');

  return { outputPath: outPath, filesWritten: files.length, issues: [] };
}

function assembleZip(files, manifest, config) {
  // Minimal ZIP implementation using Node stdlib
  // ZIP format: local file headers + data + central directory + end record
  const outPath = config.outputDir
    ? path.resolve(config.outputDir, 'project.zip')
    : path.resolve('project.zip');

  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });

  const entries = [];
  const buffers = [];
  let offset = 0;

  for (const file of files) {
    if (!file.path || !file.content) continue;
    const data = Buffer.from(file.content, 'utf-8');
    const nameBuffer = Buffer.from(file.path, 'utf-8');

    // Local file header (30 + name length)
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // Local file header signature
    header.writeUInt16LE(20, 4); // Version needed
    header.writeUInt16LE(0, 6); // General purpose bit flag
    header.writeUInt16LE(0, 8); // Compression method (0 = stored)
    header.writeUInt16LE(0, 10); // Last mod time
    header.writeUInt16LE(0, 12); // Last mod date
    header.writeUInt32LE(crc32(data), 14); // CRC-32
    header.writeUInt32LE(data.length, 18); // Compressed size
    header.writeUInt32LE(data.length, 22); // Uncompressed size
    header.writeUInt16LE(nameBuffer.length, 26); // File name length
    header.writeUInt16LE(0, 28); // Extra field length

    entries.push({ offset, nameBuffer, data, crc: crc32(data) });
    buffers.push(header, nameBuffer, data);
    offset += 30 + nameBuffer.length + data.length;
  }

  // Central directory
  const centralStart = offset;
  for (const entry of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // Central dir header sig
    cd.writeUInt16LE(20, 4); // Version made by
    cd.writeUInt16LE(20, 6); // Version needed
    cd.writeUInt16LE(0, 8); // Flags
    cd.writeUInt16LE(0, 10); // Compression
    cd.writeUInt16LE(0, 12); // Time
    cd.writeUInt16LE(0, 14); // Date
    cd.writeUInt32LE(entry.crc, 16); // CRC
    cd.writeUInt32LE(entry.data.length, 20); // Compressed size
    cd.writeUInt32LE(entry.data.length, 24); // Uncompressed size
    cd.writeUInt16LE(entry.nameBuffer.length, 28); // Name length
    cd.writeUInt16LE(0, 30); // Extra length
    cd.writeUInt16LE(0, 32); // Comment length
    cd.writeUInt16LE(0, 34); // Disk number start
    cd.writeUInt16LE(0, 36); // Internal attributes
    cd.writeUInt32LE(0, 38); // External attributes
    cd.writeUInt32LE(entry.offset, 42); // Relative offset
    buffers.push(cd, entry.nameBuffer);
    offset += 46 + entry.nameBuffer.length;
  }

  // End of central directory
  const ecd = Buffer.alloc(22);
  ecd.writeUInt32LE(0x06054b50, 0); // End of central dir sig
  ecd.writeUInt16LE(0, 4); // Disk number
  ecd.writeUInt16LE(0, 6); // Central dir disk
  ecd.writeUInt16LE(entries.length, 8); // Entries on this disk
  ecd.writeUInt16LE(entries.length, 10); // Total entries
  ecd.writeUInt32LE(offset - centralStart, 12); // Central dir size
  ecd.writeUInt32LE(centralStart, 16); // Central dir offset
  ecd.writeUInt16LE(0, 20); // Comment length
  buffers.push(ecd);

  fs.writeFileSync(outPath, Buffer.concat(buffers));
  return { outputPath: outPath, filesWritten: entries.length, issues: [] };
}

// CRC-32 implementation (standard polynomial)
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

module.exports = { assemble };
