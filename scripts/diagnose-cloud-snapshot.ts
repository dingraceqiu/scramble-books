/** Run: pnpm diagnose:snapshot path/to/cloud-snapshot.json */
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import type { CloudSnapshot, CloudSnapshotV1 } from '../src/types';
import {
  deserializeCloudSnapshot,
  serializeCloudSnapshot,
  snapshotSizeDiagnostics,
} from '../src/lib/cloudSnapshot';

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('用法：pnpm diagnose:snapshot <V1-or-V2-snapshot.json>');
    process.exitCode = 1;
    return;
  }
  const parsed = JSON.parse(await readFile(inputPath, 'utf8')) as CloudSnapshot | { data?: CloudSnapshot };
  const input = 'data' in parsed && parsed.data ? parsed.data : parsed as CloudSnapshot;
  if (input.version !== 1 && input.version !== 2) {
    throw new Error('输入文件不是受支持的 Cloud Snapshot V1/V2');
  }
  const full: CloudSnapshotV1 = deserializeCloudSnapshot(input);
  const v1 = snapshotSizeDiagnostics(full, full);
  const v2Snapshot = serializeCloudSnapshot(full);
  const v2 = snapshotSizeDiagnostics(v2Snapshot, full);
  const saved = v1.totalBytes - v2.totalBytes;
  const ratio = v1.totalBytes === 0 ? 0 : saved / v1.totalBytes;

  console.log(`V1: ${formatBytes(v1.totalBytes)}`);
  console.log(`V2: ${formatBytes(v2.totalBytes)}`);
  console.log(`缩小: ${formatBytes(saved)} (${(ratio * 100).toFixed(2)}%)`);
  console.log('\nV2 各字段：');
  for (const [field, bytes] of Object.entries(v2.fieldBytes)) {
    console.log(`  ${field.padEnd(18)} ${formatBytes(bytes)}`);
  }
  console.log('\n最大书籍：');
  for (const book of v2.largestBooks) {
    console.log(`  ${book.title} [${book.bookId}] ${formatBytes(book.bytes)}`);
  }
  console.log('\ndocuments vs units.sourceText：');
  console.log(`  Canonical Source 文本  ${formatBytes(v2.duplicateText.documentsTextBytes)}`);
  console.log(`  V1 unit sourceText    ${formatBytes(v2.duplicateText.unitSourceTextBytes)}`);
  console.log(`  V2 可安全省略部分      ${formatBytes(v2.duplicateText.safelyOmittableUnitSourceTextBytes)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
