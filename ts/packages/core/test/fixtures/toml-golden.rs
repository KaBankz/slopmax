// Writes toml-golden.jsonl: what toml_edit 0.25.15 (the version slopmax
// uses) prints after each edit, for the port's TOML editor tests
// (test/toml.test.ts). Each case is one JSON line: {"case", "out"}.
//
// Regenerate: a binary crate with this as src/main.rs and
//   [dependencies]
//   toml_edit = { version = "=0.25.15", features = ["serde"] }
//   serde_json = "1"
// then `cargo run -q > toml-golden.jsonl`.
use toml_edit::{Array, ArrayOfTables, DocumentMut, Item, Table, value};

fn emit(case: &str, out: String) {
    println!("{}", serde_json::json!({ "case": case, "out": out }));
}

fn parse(text: &str) -> DocumentMut {
    text.parse().unwrap()
}

fn main() {
    // A new root key goes after the last root key, before any table.
    let mut doc = parse("# my setup\nstrategy = \"fill-first\" # drain in order\n");
    doc["api_key"] = value("sm-KEY");
    emit("append_root_key", doc.to_string());

    let mut doc = parse("# head\n\n[aliases]\nfast = \"x\"\n\n# end\n");
    doc["api_key"] = value("sm-KEY");
    emit("root_key_before_tables", doc.to_string());

    let mut doc = parse("strategy = \"x\"");
    doc["api_key"] = value("sm-KEY");
    emit("no_final_newline", doc.to_string());

    let mut doc = parse("a = 1\r\n# c\r\nb = 2\r\n");
    doc["c"] = value(3);
    emit("crlf", doc.to_string());

    let mut doc = parse("api_key = \"\"  # fill me\nx = 1\n");
    doc["api_key"] = value("sm-KEY");
    emit("replace_drops_decor", doc.to_string());

    // Config::set: decor copied from the old value.
    let mut doc = parse("# top\nstrategy = \"fill-first\"   # mine\npoll_mins = 5\n\n[notify]\ncommand = \"x\"\n");
    for (key, v) in [("strategy", toml_edit::Value::from("round-robin")), ("poll_mins", 0i64.into()), ("warm_windows", true.into())] {
        let mut v = v;
        if let Some(old) = doc.get(key).and_then(|i| i.as_value()) {
            *v.decor_mut() = old.decor().clone();
        }
        doc[key] = Item::Value(v);
    }
    emit("set_keeps_decor", doc.to_string());

    let mut doc = DocumentMut::new();
    doc["strategy"] = Item::Value("fill-first".into());
    emit("set_on_empty", doc.to_string());

    // add_key on a file with trailing comments, twice, then remove.
    let base = "# head\napi_key = \"k\"\n\n# Address.\n# listen = \"x\"\n";
    let mut doc = parse(base);
    let mut entry = Table::new();
    entry["name"] = value("laptop");
    entry["key"] = value("sm-1");
    let list: Array = ["gpt-*", "claude-*"].iter().copied().collect();
    entry["models"] = value(list);
    doc.entry("keys").or_insert_with(|| Item::ArrayOfTables(Default::default())).as_array_of_tables_mut().unwrap().push(entry);
    let first = doc.to_string();
    emit("add_key_first", first.clone());
    let mut doc = parse(&first);
    let mut entry = Table::new();
    entry["name"] = value("ci");
    entry["key"] = value("sm-2");
    doc.entry("keys").or_insert_with(|| Item::ArrayOfTables(Default::default())).as_array_of_tables_mut().unwrap().push(entry);
    let second = doc.to_string();
    emit("add_key_second", second.clone());
    let mut doc = parse(&second);
    let keys = doc.get_mut("keys").and_then(|k| k.as_array_of_tables_mut()).unwrap();
    keys.retain(|t| t.get("name").and_then(|n| n.as_str()) != Some("laptop"));
    emit("remove_key_one", doc.to_string());
    let mut doc = parse(&doc.to_string());
    let keys = doc.get_mut("keys").and_then(|k| k.as_array_of_tables_mut()).unwrap();
    keys.retain(|t| t.get("name").and_then(|n| n.as_str()) != Some("ci"));
    if keys.is_empty() { doc.remove("keys"); }
    emit("remove_key_last", doc.to_string());

    // Keys after other tables.
    let mut doc = parse("api_key = \"k\"\n\n[aliases]\nfast = \"m\"\n\n# tail\n");
    let mut entry = Table::new();
    entry["name"] = value("x");
    doc.entry("keys").or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new())).as_array_of_tables_mut().unwrap().push(entry);
    emit("add_key_after_tables", doc.to_string());

    // A table-only file, keys first.
    let mut doc = parse("[aliases]\nfast = \"m\"\n");
    let mut entry = Table::new();
    entry["name"] = value("x");
    doc.entry("keys").or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new())).as_array_of_tables_mut().unwrap().push(entry);
    emit("add_key_table_only", doc.to_string());

    let mut doc = DocumentMut::new();
    let mut entry = Table::new();
    entry["name"] = value("x");
    doc.entry("keys").or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new())).as_array_of_tables_mut().unwrap().push(entry);
    emit("add_key_empty_doc", doc.to_string());

    // Codex-like edits.
    let codex = "model = \"gpt\"\n\n[model_providers.other]\nname = \"x\"\n\n[profiles.p]\nmodel = \"y\"\n";
    let mut doc = parse(codex);
    doc["model_provider"] = value("slopmax");
    let providers = doc.entry("model_providers").or_insert_with(|| { let mut t = Table::new(); t.set_implicit(true); Item::Table(t) }).as_table_mut().unwrap();
    let mut table = Table::new();
    table["name"] = value("OpenAI");
    table["base_url"] = value("http://127.0.0.1:7567/codex");
    table["supports_websockets"] = value(true);
    providers.insert("slopmax", Item::Table(table));
    let setup = doc.to_string();
    emit("codex_setup_existing", setup.clone());
    let mut doc = parse(&setup);
    doc.remove("model_provider");
    if let Some(p) = doc.get_mut("model_providers").and_then(Item::as_table_mut) { p.remove("slopmax"); }
    emit("codex_undo", doc.to_string());
    // And setup again over a setup (replacing the table).
    let mut doc = parse(&setup);
    let providers = doc.get_mut("model_providers").and_then(Item::as_table_mut).unwrap();
    let mut table = Table::new();
    table["name"] = value("OpenAI");
    providers.insert("slopmax", Item::Table(table));
    emit("codex_setup_again", doc.to_string());

    let mut doc = parse("# just a comment\n");
    doc["model_provider"] = value("slopmax");
    let providers = doc.entry("model_providers").or_insert_with(|| { let mut t = Table::new(); t.set_implicit(true); Item::Table(t) }).as_table_mut().unwrap();
    let mut table = Table::new();
    table["name"] = value("OpenAI");
    providers.insert("slopmax", Item::Table(table));
    emit("codex_setup_fresh", doc.to_string());

    // String and key representations.
    let mut doc = DocumentMut::new();
    for (i, s) in ["plain", "back\\slash", "q\"uote", "it's", "it's \\ both", "line\nbreak", "tab\there", "ctl\u{1}x", "trail'", "a'''b\\", "üñí", "del\u{7f}", "new\nline\\"].iter().enumerate() {
        doc[&format!("s{i}")] = value(*s);
    }
    for (i, k) in ["my model", "a.b", "", "k'ey", "ba\\ck"].iter().enumerate() {
        doc[*k] = value(i as i64);
    }
    for (i, f) in [1.0f64, 0.5, 1e20, -0.0, 2.5e-7, 100.0].iter().enumerate() {
        doc[&format!("f{i}")] = value(*f);
    }
    emit("reprs", doc.to_string());

    // A table header written new under an implicit parent, and nested tables.
    let mut doc = parse("[prices.\"my-model\"]\ninput = 2.0\noutput = 8\n");
    doc["api_key"] = value("k");
    emit("implicit_parent", doc.to_string());

    // Whitespace in headers and keys is kept.
    let mut doc = parse("  a  =  1   # one\n[ t . u ]  # hdr\n  b = 2\n");
    doc["z"] = value(1);
    emit("odd_spacing", doc.to_string());

    // Array of tables and a later table, then a removal in the middle.
    let mut doc = parse("[[keys]]\nname = \"a\"\n\n# about b\n[[keys]]\nname = \"b\"\n\n[notify]\nevents = []\n");
    let keys = doc.get_mut("keys").and_then(|k| k.as_array_of_tables_mut()).unwrap();
    keys.retain(|t| t.get("name").and_then(|n| n.as_str()) != Some("a"));
    emit("aot_remove_first", doc.to_string());

    // Multi-line values survive untouched.
    let mut doc = parse("a = [\n  1, # one\n  2,\n]\nb = \"\"\"\nx\n[not]\n\"\"\"\n");
    doc["c"] = value(true);
    emit("multiline_values", doc.to_string());
}
