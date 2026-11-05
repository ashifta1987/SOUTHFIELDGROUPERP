// Streaming reader for big TallyPrime XML files (UTF-16LE with BOM, "IMPORTDATA" envelope) so a 30 MB masters file or a 200 MB+
// Day Book can be read in Node without holding the whole file as one string. It cuts the file into <TALLYMESSAGE> blocks and
// converts batches of them with the SAME parser the Import screen uses (src/features/import/tally/parseTallyXml.ts, DOMParser from jsdom).
import { createReadStream } from 'node:fs'
import { JSDOM } from 'jsdom'
import { parseTallyXml } from '../../src/features/import/tally/parseTallyXml.ts'

if (!globalThis.DOMParser) globalThis.DOMParser = new JSDOM('').window.DOMParser

/** Async generator of raw TALLYMESSAGE strings; the first yielded value of `head` is the text before the first message. */
export async function* tallyMessages(path, { onBytes } = {}) {
  const dec = new TextDecoder('utf-16le', { stream: true })
  let buf = ''
  let first = true
  let sentHead = false
  let read = 0
  const CLOSE = '</TALLYMESSAGE>'
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) {
    read += chunk.length
    onBytes?.(read)
    let s = dec.decode(chunk, { stream: true })
    if (first) {
      first = false
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    }
    buf += s
    let pos = 0
    for (;;) {
      const end = buf.indexOf(CLOSE, pos)
      if (end < 0) break
      const start = buf.indexOf('<TALLYMESSAGE', pos)
      if (start < 0 || start > end) break
      if (!sentHead) {
        sentHead = true
        yield { head: buf.slice(0, start) }
      }
      yield { message: buf.slice(start, end + CLOSE.length) }
      pos = end + CLOSE.length
    }
    buf = buf.slice(pos)
  }
}

/**
 * Parse a file into batches of staged rows. `onRows(rows, info)` is called for every `perBatch` messages; `info.companyName` is the
 * company named in the file header. Returns {messages, companyName}.
 */
export async function streamTallyRows(path, onRows, { perBatch = 200, onBytes } = {}) {
  let batch = []
  let messages = 0
  let companyName = null
  const flush = async () => {
    if (batch.length === 0) return
    const parsed = parseTallyXml(`<ENVELOPE xmlns:UDF="TallyUDF">${batch.join('')}</ENVELOPE>`)
    batch = []
    await onRows(parsed.rows, { companyName })
  }
  for await (const part of tallyMessages(path, { onBytes })) {
    if (part.head !== undefined) {
      companyName = /<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(part.head)?.[1]?.trim() ?? null
      continue
    }
    batch.push(part.message)
    messages++
    if (batch.length >= perBatch) await flush()
  }
  await flush()
  return { messages, companyName }
}
