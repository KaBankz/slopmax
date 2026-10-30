// WebSocket framing (RFC 6455), as much as relaying Codex's sockets needs:
// the handshake keys, and reading and writing messages. No extensions are
// negotiated, so frames are never compressed.
//
// The outbound side (slopmax's socket to ChatGPT) is framed here, over the
// connection a `101` hands over (`client.Response.upgrade`). The inbound
// side is Bun's server WebSocket (`server.upgrade`), which frames for
// itself; both offer the same `message` and `send`.
// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import { ids, text as texts } from "@slopmax/common"
import { Data, Effect } from "effect"

/** Mixed into the client's key to prove the server speaks WebSocket. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/** Largest message accepted. Codex sends whole conversations at once. */
export const MAX_MESSAGE = 64 * 1024 * 1024

/** The `Sec-WebSocket-Accept` answering a `Sec-WebSocket-Key`. */
export const acceptKey = (key: string): string =>
  createHash("sha1")
    .update(`${texts.trim(key)}${GUID}`)
    .digest("base64")

/** A fresh `Sec-WebSocket-Key` for a handshake. */
export const newKey = (): string => Buffer.from(ids.random(16)).toString("base64")

/** One whole message. */
export type Message =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Binary"; readonly data: Uint8Array }
  | { readonly _tag: "Ping"; readonly data: Uint8Array }
  | { readonly _tag: "Pong"; readonly data: Uint8Array }
  /** A close, with its status code and reason when given. */
  | { readonly _tag: "Close"; readonly close: { readonly code: number; readonly reason: string } | undefined }

const closeBare: Message = { _tag: "Close", close: undefined }

export const Message = {
  text: (text: string): Message => ({ _tag: "Text", text }),
  binary: (data: Uint8Array): Message => ({ _tag: "Binary", data }),
  ping: (data: Uint8Array = new Uint8Array()): Message => ({ _tag: "Ping", data }),
  pong: (data: Uint8Array = new Uint8Array()): Message => ({ _tag: "Pong", data }),
  close: (code: number, reason: string): Message => ({ _tag: "Close", close: { code, reason } }),
  /** A close without a status. */
  closeBare: closeBare,
} as const

/** A broken frame, or a socket that failed. */
export class WsError extends Data.TaggedError("WsError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason
  }
}

/** Where messages come from: one side of a socket. */
export interface MessageReader<E = never> {
  /** The next message, or undefined when the connection ends. */
  readonly message: Effect.Effect<Message | undefined, WsError | E>
}

/** Where messages go: the other side. */
export interface MessageWriter<E = never> {
  readonly send: (message: Message) => Effect.Effect<void, WsError | E>
}

/** Bytes to read frames from: the next chunk, or undefined at the end. */
export interface ByteSource<E> {
  readonly read: Effect.Effect<Uint8Array | undefined, E>
}

/** Bytes to write frames to; each write is flushed before it succeeds. */
export interface ByteSink<E> {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, E>
}

const CONTINUATION = 0x0
const TEXT = 0x1
const BINARY = 0x2
const CLOSE = 0x8
const PING = 0x9
const PONG = 0xa

const invalid = (reason: string): WsError => new WsError({ reason })

// What tokio says when the stream ends inside a frame: in its 16- or 64-bit
// length (`read_u16`/`read_u64`), or in its key or payload (`read_exact`).
const EOF_IN_LENGTH = "unexpected end of file"
const EOF_IN_PAYLOAD = "early eof"

const utf8 = new TextEncoder()
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })

const message = (opcode: number, payload: Uint8Array): Message | WsError => {
  if (opcode !== TEXT) return Message.binary(payload)
  try {
    return Message.text(strict.decode(payload))
  } catch {
    return invalid("a text message that is not UTF-8")
  }
}

const applyMask = (data: Uint8Array, key: Uint8Array): void => {
  const k0 = key[0] ?? 0
  const k1 = key[1] ?? 0
  const k2 = key[2] ?? 0
  const k3 = key[3] ?? 0
  const n = data.length
  let i = 0
  for (; i + 4 <= n; i += 4) {
    data[i] = (data[i] ?? 0) ^ k0
    data[i + 1] = (data[i + 1] ?? 0) ^ k1
    data[i + 2] = (data[i + 2] ?? 0) ^ k2
    data[i + 3] = (data[i + 3] ?? 0) ^ k3
  }
  for (; i < n; i++) data[i] = (data[i] ?? 0) ^ (key[i % 4] ?? 0)
}

// Where parsing stopped for want of bytes: what an end of stream there means.
const IN_HEAD = 0
const IN_LENGTH = 1
const IN_PAYLOAD = 2

/**
 * Reads messages, joining fragmented ones. Frames are parsed from the bytes
 * already read, without effects; the source is read only when a frame is
 * incomplete.
 */
export class Reader<E> implements MessageReader<E> {
  // Bytes read but not yet used: `buffer[start, end)`. Bytes before `end`
  // are never written again, so payloads can be views of them.
  private buffer: Uint8Array = new Uint8Array()
  private start = 0
  private end = 0
  /** Whether {@link buffer} is ours to append to (not a chunk the source gave). */
  private owned = false
  /** Bytes the frame at {@link start} needs, once its head says. */
  private want = 0
  private short: number = IN_HEAD
  /** A fragmented message being received: its opcode and data so far. */
  private partial: { opcode: number; chunks: Array<Uint8Array>; size: number } | undefined

  constructor(private readonly inner: ByteSource<E>) {}

  /** The next message, or undefined when the connection ends. */
  get message(): Effect.Effect<Message | undefined, E | WsError> {
    return Effect.suspend(() => this.next())
  }

  private next(): Effect.Effect<Message | undefined, E | WsError> {
    const parsed = this.parse()
    if (parsed instanceof WsError) return Effect.fail(parsed)
    if (parsed !== undefined) return Effect.succeed(parsed)
    return Effect.flatMap(this.inner.read, (chunk) => {
      if (chunk === undefined) {
        // A clean end between frames (or inside a frame's first two bytes,
        // as Rust's `read_exact` there reads as one) ends the stream.
        if (this.short === IN_HEAD) return Effect.succeed(undefined)
        return Effect.fail(invalid(this.short === IN_LENGTH ? EOF_IN_LENGTH : EOF_IN_PAYLOAD))
      }
      this.feed(chunk)
      return this.next()
    })
  }

  private feed(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    const live = this.end - this.start
    if (live === 0) {
      this.buffer = chunk
      this.start = 0
      this.end = chunk.length
      this.owned = false
      return
    }
    if (this.owned && this.end + chunk.length <= this.buffer.length) {
      this.buffer.set(chunk, this.end)
      this.end += chunk.length
      return
    }
    const need = live + chunk.length
    const next = new Uint8Array(Math.max(need, this.want, live * 2))
    next.set(this.buffer.subarray(this.start, this.end))
    next.set(chunk, live)
    this.buffer = next
    this.start = 0
    this.end = need
    this.owned = true
  }

  // The next whole message from the bytes held, an error, or undefined when
  // more bytes are needed.
  private parse(): Message | WsError | undefined {
    for (;;) {
      const b = this.buffer
      const s = this.start
      const available = this.end - s
      this.short = IN_HEAD
      if (available < 2) return undefined
      const first = b[s] ?? 0
      const second = b[s + 1] ?? 0
      const fin = (first & 0x80) !== 0
      if ((first & 0x70) !== 0) return invalid("reserved bits set without an extension")
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let len = second & 0x7f
      let at = s + 2
      this.short = IN_LENGTH
      if (len === 126) {
        if (available < 4) return undefined
        len = ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
        at += 2
      } else if (len === 127) {
        if (available < 10) return undefined
        const high =
          (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0
        const low =
          (((b[at + 4] ?? 0) << 24) | ((b[at + 5] ?? 0) << 16) | ((b[at + 6] ?? 0) << 8) | (b[at + 7] ?? 0)) >>> 0
        len = high > 0x1fffff ? Number.MAX_SAFE_INTEGER : high * 0x1_0000_0000 + low
        at += 8
      }
      if (opcode >= CLOSE && (len > 125 || !fin)) return invalid("control frames are short and whole")
      if (len > MAX_MESSAGE) return invalid("message too large")
      this.short = IN_PAYLOAD
      const keyAt = at
      if (masked) at += 4
      const total = at - s + len
      if (available < total) {
        this.want = total
        return undefined
      }
      this.want = 0
      this.start = s + total
      let payload: Uint8Array
      if (masked) {
        // Unmasked in a copy: the bytes held are never written again (and a
        // Buffer's `slice` is a view, not a copy).
        payload = new Uint8Array(b.subarray(at, at + len))
        applyMask(payload, b.subarray(keyAt, keyAt + 4))
      } else {
        payload = b.subarray(at, at + len)
      }
      switch (opcode) {
        case CLOSE: {
          if (payload.length < 2) return Message.closeBare
          const code = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0)
          return Message.close(code, lossy.decode(payload.subarray(2)))
        }
        case PING:
          return Message.ping(payload)
        case PONG:
          return Message.pong(payload)
        case TEXT:
        case BINARY:
          if (this.partial !== undefined) return invalid("a new message began inside a fragmented one")
          if (!fin) {
            this.partial = { opcode, chunks: [payload], size: payload.length }
            continue
          }
          return message(opcode, payload)
        case CONTINUATION: {
          const partial = this.partial
          if (partial === undefined) return invalid("a continuation frame without a message")
          this.partial = undefined
          if (partial.size + payload.length > MAX_MESSAGE) return invalid("message too large")
          partial.chunks.push(payload)
          partial.size += payload.length
          if (fin) return message(partial.opcode, concat(partial.chunks, partial.size))
          this.partial = partial
          continue
        }
        default:
          return invalid("unknown opcode")
      }
    }
  }
}

const concat = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** Writes messages, each as one frame. A client masks its frames; a server must not. */
export class Writer<E> implements MessageWriter<E> {
  private constructor(
    private readonly inner: ByteSink<E>,
    private readonly masked: boolean,
  ) {}

  /** A writer for the client side of a connection. */
  static client<E>(inner: ByteSink<E>): Writer<E> {
    return new Writer(inner, true)
  }

  /** A writer for the server side of a connection. */
  static server<E>(inner: ByteSink<E>): Writer<E> {
    return new Writer(inner, false)
  }

  readonly send = (sent: Message): Effect.Effect<void, E> => this.inner.write(frame(sent, this.masked))
}

/** Control frames hold at most 125 bytes: a code and 123 bytes of reason. */
export const closePayload = (code: number, reason: string): Uint8Array => {
  const text = utf8.encode(reason)
  const cut = text.subarray(0, Math.min(text.length, 123))
  const out = new Uint8Array(2 + cut.length)
  out[0] = code >> 8
  out[1] = code & 0xff
  out.set(cut, 2)
  return out
}

/** `message` as one final frame, masked with a fresh key when `masked`. */
export const frame = (sent: Message, masked: boolean): Uint8Array => {
  let opcode: number
  let payload: Uint8Array
  switch (sent._tag) {
    case "Text":
      opcode = TEXT
      payload = utf8.encode(sent.text)
      break
    case "Binary":
      opcode = BINARY
      payload = sent.data
      break
    case "Ping":
      opcode = PING
      payload = sent.data
      break
    case "Pong":
      opcode = PONG
      payload = sent.data
      break
    case "Close":
      opcode = CLOSE
      payload = sent.close === undefined ? new Uint8Array() : closePayload(sent.close.code, sent.close.reason)
      break
  }
  const n = payload.length
  const lengthBytes = n < 126 ? 0 : n <= 0xffff ? 2 : 8
  const keyBytes = masked ? 4 : 0
  const out = new Uint8Array(2 + lengthBytes + keyBytes + n)
  out[0] = 0x80 | opcode
  const maskBit = masked ? 0x80 : 0
  if (lengthBytes === 0) {
    out[1] = maskBit | n
  } else if (lengthBytes === 2) {
    out[1] = maskBit | 126
    out[2] = n >> 8
    out[3] = n & 0xff
  } else {
    out[1] = maskBit | 127
    const view = new DataView(out.buffer, out.byteOffset + 2, 8)
    view.setUint32(0, Math.floor(n / 0x1_0000_0000))
    view.setUint32(4, n >>> 0)
  }
  const start = 2 + lengthBytes + keyBytes
  out.set(payload, start)
  if (masked) {
    const key = ids.random(4)
    out.set(key, 2 + lengthBytes)
    applyMask(out.subarray(start), key)
  }
  return out
}
