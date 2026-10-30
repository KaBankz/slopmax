// Writes fmt-golden.tsv: Rust's own float formatting for the port's fmt tests.
// Regenerate: a binary crate depending on serde_json = "=1.0.151" with this as src/main.rs,
// then `cargo run -q > fmt-golden.tsv`. Columns: kind, bits, {}, {:?}, serde_json, then
// {:.0} {:.1} {:.2} {:.3} {:e} for f64 and {:.1} for f32.
fn main() {
    let mut s: u64 = 0x9e3779b97f4a7c15;
    let mut next = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
    let mut vals: Vec<f64> = Vec::new();
    for _ in 0..120 { // random bits, magnitudes kept moderate
        let b = next();
        let exp = 1023 - 30 + (next() % 70) as u64;
        let v = f64::from_bits((b & 0x800f_ffff_ffff_ffff) | (exp << 52));
        vals.push(v);
    }
    for _ in 0..120 { let k = (next() % 200_000) as f64; vals.push(k / 1000.0); }
    for _ in 0..60 { let k = (next() % 4096) as f64; vals.push(k / 64.0 * if next() % 2 == 0 { 1.0 } else { -1.0 }); }
    for _ in 0..60 { let k = (next() % 1_000_000_000_000) as f64; vals.push(k / 100.0); }
    for _ in 0..30 { let k = (next() % 100_000) as f64; vals.push(k * 1e-9); }
    // Values exactly halfway between two shortest candidates, where Rust's
    // formatting and ryu settle ties differently.
    for i in 0..40u64 { let b = 50 - (i % 4) as i32; let q = 2f64.powi(-(52 - b)); vals.push(2f64.powi(b) + q * (2 * (next() % 1000) + 1) as f64); }
    for v in &vals {
        println!("f64\t{}\t{}\t{:?}\t{}\t{:.0}\t{:.1}\t{:.2}\t{:.3}\t{:e}", v.to_bits(), v, v, serde_json::to_string(v).unwrap(), v, v, v, v, v);
    }
    let mut fl: Vec<f32> = Vec::new();
    for _ in 0..150 {
        let b = next() as u32;
        let exp = 127 - 30 + (next() % 75) as u32;
        fl.push(f32::from_bits((b & 0x807f_ffff) | (exp << 23)));
    }
    for _ in 0..80 { let n = (next() % 10_000) as f32; let d = (next() % 10_000 + 1) as f32; fl.push(n / d); }
    // powers of two, where the shortest-digit interval is lopsided
    for e in -60..90 { fl.push(2f32.powi(e)); }
    for i in 0..40u32 { let b = 21 - (i % 4) as i32; let q = 2f32.powi(-(23 - b)); fl.push(2f32.powi(b) + q * (2 * (next() % 1000) + 1) as f32); }
    for v in &fl {
        println!("f32\t{}\t{}\t{:?}\t{}\t{:.1}", v.to_bits(), v, v, serde_json::to_string(v).unwrap(), v);
    }
}
