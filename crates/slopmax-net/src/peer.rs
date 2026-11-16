//! Who is on the other end of a TCP connection to this machine.
//!
//! Linux lists every TCP socket in `/proc/net/tcp` and `/proc/net/tcp6`,
//! with the uid that owns it. The other end of a connection from this
//! machine is the socket whose own address is the connection's peer and
//! whose remote address is the server's end: its uid is who connected.
//! Other systems have no such list; there the answer is `None`.

use std::net::SocketAddr;

use crate::server::TcpEnds;

/// The uid that owns the client's end of `ends`, a connection from this
/// machine. `None` when that socket isn't listed (it has closed, or came
/// from elsewhere) or the system doesn't say.
pub fn uid(ends: TcpEnds) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        ["/proc/net/tcp", "/proc/net/tcp6"].iter().find_map(|file| {
            let table = std::fs::read_to_string(file).ok()?;
            find(&table, ends)
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = ends;
        None
    }
}

/// The uid of the row in a `/proc/net/tcp` `table` whose own address is
/// the peer's and whose remote address is the server's.
fn find(table: &str, ends: TcpEnds) -> Option<u32> {
    let peer = canonical(ends.peer);
    let local = canonical(ends.local);
    table.lines().skip(1).find_map(|row| {
        let mut fields = row.split_whitespace();
        let own = address(fields.nth(1)?)?;
        let remote = address(fields.next()?)?;
        let uid = fields.nth(4)?.parse().ok()?;
        (own == peer && remote == local).then_some(uid)
    })
}

/// `addr` with an IPv4-mapped IPv6 address as plain IPv4, as a dual-stack
/// listener sees an IPv4 client and its own end.
fn canonical(addr: SocketAddr) -> SocketAddr {
    SocketAddr::new(addr.ip().to_canonical(), addr.port())
}

/// A `/proc/net/tcp` address: hex `ADDR:PORT`, the address as 32-bit words
/// in the machine's byte order (8 digits for IPv4, 32 for IPv6), the port
/// as written.
fn address(text: &str) -> Option<SocketAddr> {
    let (ip, port) = text.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let word = |i: usize| -> Option<[u8; 4]> {
        let hex = ip.get(i * 8..i * 8 + 8)?;
        Some(u32::from_str_radix(hex, 16).ok()?.to_ne_bytes())
    };
    let ip = match ip.len() {
        8 => std::net::IpAddr::from(word(0)?),
        32 => {
            let mut bytes = [0u8; 16];
            for i in 0..4 {
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word(i)?);
            }
            std::net::IpAddr::from(bytes)
        }
        _ => return None,
    };
    Some(canonical(SocketAddr::new(ip, port)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ends(peer: &str, local: &str) -> TcpEnds {
        TcpEnds {
            peer: peer.parse().unwrap(),
            local: local.parse().unwrap(),
        }
    }

    /// A row as the machine writes it: its words in its own byte order.
    fn hex4(ip: [u8; 4]) -> String {
        format!("{:08X}", u32::from_ne_bytes(ip))
    }

    #[test]
    fn finds_the_row_of_the_client_end() {
        let lo = hex4([127, 0, 0, 1]);
        let table = format!(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
             \x20  0: {lo}:1D8F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n\
             \x20  1: {lo}:1D8F {lo}:A2B4 01 00000000:00000000 00:00000000 00000000  1000        0 2 1\n\
             \x20  2: {lo}:A2B4 {lo}:1D8F 01 00000000:00000000 00:00000000 00000000     0        0 3 1\n"
        );
        // 0x1D8F is 7567, 0xA2B4 is 41652.
        assert_eq!(
            find(&table, ends("127.0.0.1:41652", "127.0.0.1:7567")),
            Some(0)
        );
        assert_eq!(
            find(&table, ends("127.0.0.1:41653", "127.0.0.1:7567")),
            None
        );
        // A dual-stack listener sees an IPv4 client as IPv4-mapped.
        assert_eq!(
            find(
                &table,
                ends("[::ffff:127.0.0.1]:41652", "[::ffff:127.0.0.1]:7567")
            ),
            Some(0)
        );
    }

    #[test]
    fn reads_ipv6_rows() {
        let words: String = [[0u8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]
            .into_iter()
            .map(hex4)
            .collect();
        assert_eq!(
            address(&format!("{words}:1D8F")),
            Some("[::1]:7567".parse().unwrap())
        );
        assert_eq!(address("zz:1D8F"), None);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_connection_from_this_process_is_its_own_uid() {
        use std::os::unix::fs::MetadataExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, peer) = listener.accept().await.unwrap();
        let ends = TcpEnds {
            peer,
            local: server.local_addr().unwrap(),
        };
        let me = std::fs::metadata("/proc/self").unwrap().uid();
        assert_eq!(uid(ends), Some(me));
        drop(client);
    }
}
