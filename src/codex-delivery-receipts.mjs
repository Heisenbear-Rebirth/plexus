import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { contextSourcePath } from './context-usage.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const idPattern = /^[0-9a-f-]{36}$/i;

// Native incoming peer messages use a named tool-output wrapper. Merely finding
// an ID in assistant prose, a shell result, or a quoted report is not a receipt.
export function codexDeliveryReceipt(row) {
  const p = row?.payload;
  if (row?.type !== 'response_item' || p?.type !== 'function_call_output'
    || p.namespace !== 'codex_app' || p.name !== 'send_message_to_thread' || typeof p.output !== 'string') return null;
  const match = /^<codex_delegation>\s*<source_thread_id>([0-9a-f-]{36})<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/i.exec(p.output);
  if (!match || !Number.isFinite(Date.parse(row.timestamp))) return null;
  const messageId = /(?:^|\n)消息编号：([0-9a-f-]{36})\n\n/i.exec(match[2])?.[1];
  if (!messageId) return null;
  return { kind: 'codex-native-receipt', messageId, sourceThreadId: match[1], receivedAt: row.timestamp, contentHash: digest(match[2]) };
}

export class CodexDeliveryReceipts {
  constructor({ locate = contextSourcePath } = {}) { this.locate = locate; this.readers = new Map(); }
  async find(record, renderedText) {
    if (record.to?.client !== 'codex' || !idPattern.test(record.to.id) || !idPattern.test(record.id)) return null;
    const sessionId = record.to.id.toLowerCase(), filename = await this.locate({ client: 'codex', id: sessionId });
    // A session that just received a message is active, so its rollout is not
    // an archive; compressed bytes can never prove a delivery.
    if (filename.endsWith('.zst')) return null;
    const info = await stat(filename);
    let reader = this.readers.get(sessionId);
    if (!reader || reader.filename !== filename || info.size < reader.offset || reader.birthtimeMs !== info.birthtimeMs) {
      reader = { filename, birthtimeMs: info.birthtimeMs, offset: 0, pending: '', decoder: new StringDecoder('utf8'),
        validSession: false, receipts: new Map(), discarding: false };
      this.readers.set(sessionId, reader);
    }
    if (info.size > reader.offset) {
      const input = createReadStream(filename, { start: reader.offset, end: info.size - 1 });
      for await (const bytes of input) {
        const parts = reader.decoder.write(bytes).split('\n');
        for (let index = 0; index < parts.length; index++) {
          if (!reader.discarding) reader.pending += parts[index];
          if (reader.pending.length > 4 * 1024 * 1024) { reader.pending = ''; reader.discarding = true; }
          if (index === parts.length - 1) continue;
          if (!reader.discarding && (reader.pending.includes('session_meta') || reader.pending.includes('codex_delegation'))) {
            try {
              const row = JSON.parse(reader.pending);
              if (row.type === 'session_meta') reader.validSession = row.payload?.id?.toLowerCase() === sessionId;
              else if (reader.validSession) {
                const receipt = codexDeliveryReceipt(row);
                if (receipt) {
                  const key = receipt.messageId + ':' + receipt.contentHash;
                  reader.receipts.delete(key); reader.receipts.set(key, { ...receipt, sessionId });
                  if (reader.receipts.size > 2048) reader.receipts.delete(reader.receipts.keys().next().value);
                }
              }
            } catch { /* Incomplete or unrelated native data cannot prove delivery. */ }
          }
          reader.pending = ''; reader.discarding = false;
        }
        reader.offset += bytes.length;
      }
    }
    const receipt = reader.validSession ? reader.receipts.get(record.id + ':' + digest(renderedText)) : null;
    return receipt && Date.parse(receipt.receivedAt) >= Date.parse(record.createdAt) ? { ...receipt } : null;
  }
}
