import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDiagnosticLogs,
  formatDiagnosticLogsText,
  getDiagnosticLogs,
  logError,
  logInfo,
  logWarn,
} from '../src/infrastructure/logger';

describe('diagnostic logger', () => {
  beforeEach(() => {
    clearDiagnosticLogs();
  });

  it('records info, warn, and error entries with sanitized bearer tokens', () => {
    logInfo('gateway', 'resolved_gateway_url', { url: 'https://stickerwave.onrender.com' });
    logWarn('storage', 'missing_blob_healed', { code: '4002', meta: { droppedAssets: 1 } });
    logError('gateway', 'auth_header_failure', {
      code: '7001',
      detail: new Error('Rejected Authorization: Bearer super-secret-token-12345'),
    });

    const entries = getDiagnosticLogs();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].level, 'info');
    assert.equal(entries[1].code, '4002');
    assert.equal(entries[2].level, 'error');
    assert.ok(entries[2].detail?.includes('Bearer [redacted]'));
    assert.ok(!entries[2].detail?.includes('super-secret-token-12345'));

    const text = formatDiagnosticLogsText(10);
    assert.ok(text.includes('[INFO] gateway:resolved_gateway_url'));
    assert.ok(text.includes('[ERROR] gateway:auth_header_failure (7001)'));
  });

  it('caps the in-memory ring buffer at 150 entries', () => {
    for (let i = 0; i < 180; i++) {
      logInfo('test', `evt_${i}`);
    }
    const entries = getDiagnosticLogs();
    assert.equal(entries.length, 150);
    assert.equal(entries[0].event, 'evt_30');
    assert.equal(entries[entries.length - 1].event, 'evt_179');
  });
});
