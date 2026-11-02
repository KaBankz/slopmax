//! WebSocket framing (RFC 6455), as much as relaying Codex's sockets needs:
//! the handshake keys, and reading and writing messages. No extensions are
//! negotiated, so frames are never compressed.

use std::io;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::BytesMut;
use ring::digest;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Mixed into the client's key to prove the server speaks WebSocket.
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// Largest message accepted. Codex sends whole conversations at once.
pub const MAX_MESSAGE: usize = 64 * 1024 * 1024;

/// The `Sec-WebSocket-Accept` answering a `Sec-WebSocket-Key`.
pub fn accept_key(key: &str) -> String {
    let joined = format!("{}{GUID}", key.trim());
    let hash = digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, joined.as_bytes());
    STANDARD.encode(hash.as_ref())
}

/// A fresh `Sec-WebSocket-Key` for a handshake.
pub fn new_key() -> String {
    STANDARD.encode(slopmax_common::ids::random::<16>())
}

/// One whole message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    /// A close, with its status code and reason when given.
    Close(Option<(u16, String)>),
}

impl Message {
    pub fn close(code: u16, reason: &str) -> Self {
        Self::Close(Some((code, reason.to_owned())))
    }
}

const CONTINUATION: u8 = 0x0;
const TEXT: u8 = 0x1;
const BINARY: u8 = 0x2;
const CLOSE: u8 = 0x8;
const PING: u8 = 0x9;
const PONG: u8 = 0xA;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Reads messages, joining fragmented ones.
///
/// [`Reader::message`] is cancel-safe: whatever it has read is kept in the
/// reader, not in the future, so it can race other work in a `select!` and
/// be called again without losing a byte.
pub struct Reader<R> {
    inner: R,
    /// Bytes read and not yet framed.
    buf: BytesMut,
    /// A fragmented message being received: its opcode and data so far.
    partial: Option<(u8, Vec<u8>)>,
}

impl<R: AsyncRead + Unpin> Reader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buf: BytesMut::with_capacity(8 * 1024),
            partial: None,
        }
    }

    /// The next message, or `None` when the connection ends.
    pub async fn message(&mut self) -> io::Result<Option<Message>> {
        loop {
            while let Some(frame) = parse(&mut self.buf)? {
                if let Some(message) = self.join(frame)? {
                    return Ok(Some(message));
                }
            }
            // Cancel-safe: dropped before it completes, it has read nothing.
            if self.inner.read_buf(&mut self.buf).await? == 0 {
                return match self.buf.is_empty() && self.partial.is_none() {
                    true => Ok(None),
                    false => Err(io::ErrorKind::UnexpectedEof.into()),
                };
            }
        }
    }

    /// Folds one frame in: a whole message when it completes one.
    fn join(&mut self, frame: Frame) -> io::Result<Option<Message>> {
        let Frame {
            fin,
            opcode,
            payload,
        } = frame;
        match opcode {
            CLOSE => {
                let close = (payload.len() >= 2).then(|| {
                    let code = u16::from_be_bytes([payload[0], payload[1]]);
                    (code, String::from_utf8_lossy(&payload[2..]).into_owned())
                });
                Ok(Some(Message::Close(close)))
            }
            PING => Ok(Some(Message::Ping(payload))),
            PONG => Ok(Some(Message::Pong(payload))),
            TEXT | BINARY if self.partial.is_some() => {
                Err(invalid("a new message began inside a fragmented one"))
            }
            TEXT | BINARY if !fin => {
                self.partial = Some((opcode, payload));
                Ok(None)
            }
            TEXT | BINARY => message(opcode, payload).map(Some),
            CONTINUATION => {
                let Some((first, mut data)) = self.partial.take() else {
                    return Err(invalid("a continuation frame without a message"));
                };
                if data.len() + payload.len() > MAX_MESSAGE {
                    return Err(invalid("message too large"));
                }
                data.extend_from_slice(&payload);
                if fin {
                    return message(first, data).map(Some);
                }
                self.partial = Some((first, data));
                Ok(None)
            }
            _ => Err(invalid("unknown opcode")),
        }
    }
}

/// One frame: whether it is final, its opcode, and its unmasked payload.
#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Takes the first whole frame off the front of `buf`, if one is there.
/// Pure: it reads nothing, so it is tested and fuzzed on bytes alone.
pub fn parse(buf: &mut BytesMut) -> io::Result<Option<Frame>> {
    let Some(&[first, second]) = buf.get(..2).map(|h| <&[u8; 2]>::try_from(h).unwrap()) else {
        return Ok(None);
    };
    if first & 0x70 != 0 {
        return Err(invalid("reserved bits set without an extension"));
    }
    let (fin, opcode, masked) = (first & 0x80 != 0, first & 0x0F, second & 0x80 != 0);
    let (len, mut at) = match second & 0x7F {
        126 => match buf.get(2..4) {
            Some(n) => (u64::from(u16::from_be_bytes([n[0], n[1]])), 4),
            None => return Ok(None),
        },
        127 => match buf.get(2..10) {
            Some(n) => (u64::from_be_bytes(n.try_into().expect("eight bytes")), 10),
            None => return Ok(None),
        },
        n => (u64::from(n), 2),
    };
    if opcode >= CLOSE && (len > 125 || !fin) {
        return Err(invalid("control frames are short and whole"));
    }
    if len > MAX_MESSAGE as u64 {
        return Err(invalid("message too large"));
    }
    let key = if masked {
        let Some(key) = buf.get(at..at + 4) else {
            return Ok(None);
        };
        at += 4;
        Some([key[0], key[1], key[2], key[3]])
    } else {
        None
    };
    let end = at + len as usize;
    if buf.len() < end {
        // Room for the rest, so it arrives in as few reads as it can.
        buf.reserve(end - buf.len());
        return Ok(None);
    }
    let mut frame = buf.split_to(end);
    let mut payload = frame.split_off(at).to_vec();
    if let Some(key) = key {
        apply_mask(&mut payload, key);
    }
    Ok(Some(Frame {
        fin,
        opcode,
        payload,
    }))
}

fn message(opcode: u8, payload: Vec<u8>) -> io::Result<Message> {
    if opcode == TEXT {
        String::from_utf8(payload)
            .map(Message::Text)
            .map_err(|_| invalid("a text message that is not UTF-8"))
    } else {
        Ok(Message::Binary(payload))
    }
}

/// XORs `data` with the repeating `key`, eight bytes at a time.
fn apply_mask(data: &mut [u8], key: [u8; 4]) {
    let word = u64::from_ne_bytes([
        key[0], key[1], key[2], key[3], key[0], key[1], key[2], key[3],
    ]);
    let (words, rest) = data.as_chunks_mut::<8>();
    for chunk in words {
        *chunk = (u64::from_ne_bytes(*chunk) ^ word).to_ne_bytes();
    }
    // The rest starts at a multiple of eight, so on a key boundary.
    for (byte, k) in rest.iter_mut().zip(key.iter().cycle()) {
        *byte ^= k;
    }
}

/// Mask keys for one connection: drawn from the system's RNG once, then
/// from xorshift, so a frame costs no system call. Masks keep a browser's
/// proxies from reading frames as HTTP; they need not be secret.
struct Masks(u64);

impl Masks {
    fn new() -> Self {
        Self(u64::from_ne_bytes(slopmax_common::ids::random::<8>()) | 1)
    }

    fn next(&mut self) -> [u8; 4] {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 as u32).to_ne_bytes()
    }
}

/// Writes messages, each as one frame. A client masks its frames; a
/// server must not.
pub struct Writer<W> {
    inner: W,
    masks: Option<Masks>,
    frame: Vec<u8>,
}

impl<W: AsyncWrite + Unpin> Writer<W> {
    /// A writer for the client side of a connection.
    pub fn client(inner: W) -> Self {
        Self {
            inner,
            masks: Some(Masks::new()),
            frame: Vec::new(),
        }
    }

    /// A writer for the server side of a connection.
    pub fn server(inner: W) -> Self {
        Self {
            inner,
            masks: None,
            frame: Vec::new(),
        }
    }

    pub async fn send(&mut self, message: &Message) -> io::Result<()> {
        let (opcode, payload): (u8, std::borrow::Cow<[u8]>) = match message {
            Message::Text(text) => (TEXT, text.as_bytes().into()),
            Message::Binary(data) => (BINARY, data.into()),
            Message::Ping(data) => (PING, data.into()),
            Message::Pong(data) => (PONG, data.into()),
            Message::Close(None) => (CLOSE, Vec::new().into()),
            Message::Close(Some((code, reason))) => {
                let mut data = code.to_be_bytes().to_vec();
                // Control frames hold at most 125 bytes.
                let reason = &reason.as_bytes()[..reason.len().min(123)];
                data.extend_from_slice(reason);
                (CLOSE, data.into())
            }
        };
        // One buffer per writer, reused: one write per frame.
        let frame = &mut self.frame;
        frame.clear();
        frame.reserve(payload.len() + 14);
        frame.push(0x80 | opcode);
        let mask_bit = if self.masks.is_some() { 0x80 } else { 0 };
        match payload.len() {
            n if n < 126 => frame.push(mask_bit | n as u8),
            n if n <= usize::from(u16::MAX) => {
                frame.push(mask_bit | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(mask_bit | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        if let Some(masks) = &mut self.masks {
            let key = masks.next();
            frame.extend_from_slice(&key);
            let start = frame.len();
            frame.extend_from_slice(&payload);
            apply_mask(&mut frame[start..], key);
        } else {
            frame.extend_from_slice(&payload);
        }
        self.inner.write_all(frame).await?;
        self.inner.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_key_matches_the_rfc() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        assert_eq!(STANDARD.decode(new_key()).unwrap().len(), 16);
    }

    #[tokio::test]
    async fn reads_the_rfcs_frames() {
        // RFC 6455 5.7: an unmasked and a masked "Hello", then a fragmented
        // "Hello" with a ping between its fragments.
        let bytes: &[u8] = &[
            0x81, 0x05, b'H', b'e', b'l', b'l', b'o', //
            0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58, //
            0x01, 0x03, b'H', b'e', b'l', //
            0x89, 0x00, //
            0x80, 0x02, b'l', b'o',
        ];
        let mut reader = Reader::new(bytes);
        for expected in [
            Message::Text("Hello".into()),
            Message::Text("Hello".into()),
            Message::Ping(Vec::new()),
            Message::Text("Hello".into()),
        ] {
            assert_eq!(reader.message().await.unwrap(), Some(expected));
        }
        assert_eq!(reader.message().await.unwrap(), None);
    }

    #[tokio::test]
    async fn round_trips_every_size_masked_or_not() {
        for masked in [false, true] {
            for len in [0, 125, 126, 65_535, 65_536, 200_000] {
                let text = "x".repeat(len);
                let mut wire = Vec::new();
                let mut writer = if masked {
                    Writer::client(&mut wire)
                } else {
                    Writer::server(&mut wire)
                };
                writer.send(&Message::Text(text.clone())).await.unwrap();
                writer.send(&Message::close(1000, "bye")).await.unwrap();
                assert_eq!(wire[1] & 0x80 != 0, masked);
                let mut reader = Reader::new(&wire[..]);
                assert_eq!(reader.message().await.unwrap(), Some(Message::Text(text)));
                assert_eq!(
                    reader.message().await.unwrap(),
                    Some(Message::Close(Some((1000, "bye".into()))))
                );
            }
        }
    }

    #[test]
    fn frames_split_anywhere_parse_the_same() {
        let mut wire = Vec::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut writer = Writer::client(&mut wire);
            writer.send(&Message::Text("x".repeat(300))).await.unwrap();
            writer.send(&Message::Ping(b"p".to_vec())).await.unwrap();
        });
        for cut in 0..=wire.len() {
            let mut buf = BytesMut::from(&wire[..cut]);
            let mut frames = Vec::new();
            while let Some(frame) = parse(&mut buf).unwrap() {
                frames.push(frame);
            }
            buf.extend_from_slice(&wire[cut..]);
            while let Some(frame) = parse(&mut buf).unwrap() {
                frames.push(frame);
            }
            assert_eq!(frames.len(), 2, "cut at {cut}");
            assert_eq!(frames[0].payload, "x".repeat(300).into_bytes());
            assert_eq!(frames[1].payload, b"p");
        }
    }

    #[tokio::test]
    async fn a_read_dropped_midway_loses_nothing() {
        let (mut ours, theirs) = tokio::io::duplex(64);
        let mut reader = Reader::new(theirs);
        let mut wire = Vec::new();
        Writer::client(&mut wire)
            .send(&Message::Text("hello there".into()))
            .await
            .unwrap();
        // Half the frame, then a read that is abandoned.
        ours.write_all(&wire[..5]).await.unwrap();
        let abandoned =
            tokio::time::timeout(std::time::Duration::from_millis(20), reader.message()).await;
        assert!(abandoned.is_err());
        ours.write_all(&wire[5..]).await.unwrap();
        assert_eq!(
            reader.message().await.unwrap(),
            Some(Message::Text("hello there".into()))
        );
        drop(ours);
        assert_eq!(reader.message().await.unwrap(), None);
    }

    #[test]
    fn masking_by_words_matches_masking_by_bytes() {
        let key = [0x37, 0xfa, 0x21, 0x3d];
        for len in 0..40 {
            let data: Vec<u8> = (0..len as u8).collect();
            let mut fast = data.clone();
            apply_mask(&mut fast, key);
            let slow: Vec<u8> = data
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ key[i % 4])
                .collect();
            assert_eq!(fast, slow);
        }
    }

    #[tokio::test]
    async fn rejects_broken_frames() {
        // Reserved bits, a long control frame, and a stray continuation.
        for bytes in [
            &[0xC1u8, 0x00][..],
            &[0x89, 0x7E, 0x00, 0x80][..],
            &[0x80, 0x00][..],
        ] {
            assert!(Reader::new(bytes).message().await.is_err(), "{bytes:?}");
        }
    }
}
