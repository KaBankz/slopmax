//! WebSocket framing (RFC 6455), as much as relaying Codex's sockets needs:
//! the handshake keys, and reading and writing messages. No extensions are
//! negotiated, so frames are never compressed.

use std::io;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
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
    STANDARD.encode(crate::ids::random::<16>())
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
pub struct Reader<R> {
    inner: R,
    /// A fragmented message being received: its opcode and data so far.
    partial: Option<(u8, Vec<u8>)>,
}

impl<R: AsyncRead + Unpin> Reader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            partial: None,
        }
    }

    /// The next message, or `None` when the connection ends.
    pub async fn message(&mut self) -> io::Result<Option<Message>> {
        loop {
            let Some((fin, opcode, payload)) = self.frame().await? else {
                return Ok(None);
            };
            match opcode {
                CLOSE => {
                    let close = (payload.len() >= 2).then(|| {
                        let code = u16::from_be_bytes([payload[0], payload[1]]);
                        (code, String::from_utf8_lossy(&payload[2..]).into_owned())
                    });
                    return Ok(Some(Message::Close(close)));
                }
                PING => return Ok(Some(Message::Ping(payload))),
                PONG => return Ok(Some(Message::Pong(payload))),
                TEXT | BINARY if self.partial.is_some() => {
                    return Err(invalid("a new message began inside a fragmented one"));
                }
                TEXT | BINARY if !fin => self.partial = Some((opcode, payload)),
                TEXT | BINARY => return message(opcode, payload).map(Some),
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
                }
                _ => return Err(invalid("unknown opcode")),
            }
        }
    }

    /// One frame: whether it is final, its opcode, and its unmasked
    /// payload. `None` at a clean end of the stream.
    async fn frame(&mut self) -> io::Result<Option<(bool, u8, Vec<u8>)>> {
        let mut head = [0u8; 2];
        match self.inner.read_exact(&mut head).await {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let fin = head[0] & 0x80 != 0;
        if head[0] & 0x70 != 0 {
            return Err(invalid("reserved bits set without an extension"));
        }
        let opcode = head[0] & 0x0F;
        let masked = head[1] & 0x80 != 0;
        let len = match head[1] & 0x7F {
            126 => u64::from(self.inner.read_u16().await?),
            127 => self.inner.read_u64().await?,
            n => u64::from(n),
        };
        if opcode >= CLOSE && (len > 125 || !fin) {
            return Err(invalid("control frames are short and whole"));
        }
        if len > MAX_MESSAGE as u64 {
            return Err(invalid("message too large"));
        }
        let mut key = [0u8; 4];
        if masked {
            self.inner.read_exact(&mut key).await?;
        }
        let mut payload = vec![0u8; len as usize];
        self.inner.read_exact(&mut payload).await?;
        if masked {
            apply_mask(&mut payload, key);
        }
        Ok(Some((fin, opcode, payload)))
    }
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

fn apply_mask(data: &mut [u8], key: [u8; 4]) {
    for (i, byte) in data.iter_mut().enumerate() {
        *byte ^= key[i % 4];
    }
}

/// Writes messages, each as one frame. A client masks its frames; a
/// server must not.
pub struct Writer<W> {
    inner: W,
    masked: bool,
}

impl<W: AsyncWrite + Unpin> Writer<W> {
    /// A writer for the client side of a connection.
    pub fn client(inner: W) -> Self {
        Self {
            inner,
            masked: true,
        }
    }

    /// A writer for the server side of a connection.
    pub fn server(inner: W) -> Self {
        Self {
            inner,
            masked: false,
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
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        let mask_bit = if self.masked { 0x80 } else { 0 };
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
        if self.masked {
            let key = crate::ids::random::<4>();
            frame.extend_from_slice(&key);
            let start = frame.len();
            frame.extend_from_slice(&payload);
            apply_mask(&mut frame[start..], key);
        } else {
            frame.extend_from_slice(&payload);
        }
        self.inner.write_all(&frame).await?;
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
