// Writes wire-golden.jsonl: what the Rust slopmax-wire does with each input,
// for the port's golden tests (test/golden.test.ts).
//
// Regenerate: a binary crate with this as src/main.rs and
//   [dependencies]
//   slopmax-wire = { path = "<repo>/crates/slopmax-wire" }
//   slopmax-common = { path = "<repo>/crates/slopmax-common" }
//   serde_json = { version = "=1.0.151", features = ["preserve_order"] }
// then `cargo run -q > wire-golden.jsonl`.
//
// Random ids (`msg_…`, `resp_…`, `chatcmpl-…`, a 43-character token) read as
// `<prefix>ID`, and `created`/`created_at` as 0, on both sides.
use serde_json::{Value, json};
use slopmax_common::time::Timestamp;
use slopmax_wire::ir::{Answer, Event, Failure, Stop};
use slopmax_wire::translate::{self, Decoder, Encoder};
use slopmax_wire::{Dialect, Outcome};

const DIALECTS: [Dialect; 3] = [Dialect::Messages, Dialect::Responses, Dialect::Chat];

fn normalize(text: &str) -> String {
    let prefixes = ["chatcmpl-", "resp_", "msg_", "rs_", "fc_", "ctc_", "cmp_", "call_"];
    let bytes = text.as_bytes();
    let token = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < bytes.len() {
        for p in prefixes {
            if text[i..].starts_with(p) {
                let start = i + p.len();
                if start + 43 <= bytes.len() && bytes[start..start + 43].iter().all(|b| token(*b)) {
                    out.push_str(p);
                    out.push_str("ID");
                    i = start + 43;
                    continue 'outer;
                }
            }
        }
        for key in ["\"created_at\":", "\"created\":"] {
            if text[i..].starts_with(key) {
                let mut j = i + key.len();
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + key.len() {
                    out.push_str(key);
                    out.push('0');
                    i = j;
                    continue 'outer;
                }
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn line(value: Value) {
    println!("{}", serde_json::to_string(&value).unwrap());
}

fn requests() -> Vec<(Dialect, String)> {
    let mut out = Vec::new();
    let messages = [
        r#"{"model":"gpt-6-sol","max_tokens":32000,"stream":true,"temperature":1,"top_p":0.95,
            "system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2"},{"type":"text","text":"  "},{"type":"text","text":"You are Claude Code."}],
            "messages":[{"role":"user","content":"list files"},
              {"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"s"},{"type":"text","text":"Running ls."},{"type":"text","text":""},
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls","timeout":1.0,"n":12345678901234567890,"f":0.1,"e":1e300}}]},
              {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"a.rs"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR"}}],"is_error":true},
                {"type":"document","source":{"type":"text","data":"plain doc"}},
                {"type":"document","title":"spec.pdf","source":{"type":"base64","media_type":"application/pdf","data":"JVBER"}},
                {"type":"image","source":{"type":"url","url":"https://x.dev/a.png"}},
                {"type":"tool_use","id":"toolu_2","name":"Read"}]},
              {"role":"system","content":[{"type":"redacted_thinking"}]}],
            "tools":[{"name":"Bash","description":"Run","input_schema":{"type":"object","properties":{"t":{"type":"number","minimum":0.5,"maximum":10,"default":1.0}}}},
                     {"type":"web_search_20250305","name":"web_search","max_uses":5}],
            "tool_choice":{"type":"tool","name":"Bash","disable_parallel_tool_use":true},
            "stop_sequences":["END",3],
            "thinking":{"type":"enabled","budget_tokens":10000}}"#,
        r#"{"model":"m","messages":[],"thinking":{"type":"disabled"},"tool_choice":{"type":"any"},"tools":[{"name":"x","input_schema":{}}]}"#,
        r#"{"model":"m","max_tokens":1000.0,"temperature":0.7,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"output_config":{"effort":"max"}}"#,
        r#"{"model":"m","messages":[{"role":"user","content":"x"}],"tool_choice":{"type":"none"},"tools":[{"name":"a","input_schema":{"type":"object"}}]}"#,
        r#"{"messages":[]}"#,
    ];
    for body in messages {
        out.push((Dialect::Messages, body.to_owned()));
    }
    let responses = [
        r#"{"model":"gpt-6-sol","instructions":"You are Codex.","stream":true,"max_output_tokens":500,"temperature":0.2,
            "input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"Sandbox"}]},
              {"role":"user","content":[{"type":"input_text","text":"fix it"},{"type":"input_image","image_url":"data:image/png;base64,iVBOR"},{"type":"input_file","file_data":"data:application/pdf;base64,JVBER","filename":"a.pdf"},{"type":"input_text","text":""}]},
              {"type":"reasoning","summary":[{"type":"summary_text","text":"Plan"},{"type":"summary_text","text":"More"}],"encrypted_content":"gAAA"},
              {"type":"function_call","call_id":"c1","name":"shell","arguments":"{\"command\":[\"ls\"]}"},
              {"type":"function_call_output","call_id":"c1","output":"a.rs"},
              {"type":"custom_tool_call","call_id":"c2","name":"apply_patch","input":"*** Begin Patch"},
              {"type":"custom_tool_call_output","call_id":"c2","output":[{"type":"input_text","text":"Done"},{"type":"input_image","image_url":"https://x.dev/s.png"}]},
              {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Patched."},{"type":"refusal","refusal":"no"}]},
              {"type":"reasoning","summary":[]},
              {"type":"web_search_call","id":"ws_1"},
              {"type":"message","role":"user","content":"thanks"}],
            "tools":[{"type":"function","name":"shell","description":"Run","parameters":{"type":"object","properties":{"x":{"type":"integer","maximum":1e3}}}},
                     {"type":"custom","name":"apply_patch","description":"Patch","format":{"type":"grammar"}},
                     {"type":"function","name":"bare"},
                     {"type":"web_search"}],
            "tool_choice":{"type":"function","name":"shell"},"parallel_tool_calls":false,
            "reasoning":{"effort":"xhigh","summary":"auto"},"prompt_cache_key":"conv-1",
            "text":{"format":{"type":"json_schema","name":"out","schema":{"type":"object"},"strict":true}}}"#,
        r#"{"model":"grok-4","instructions":"   ","input":"patch it","tool_choice":"required","tools":[{"type":"custom","name":"apply_patch"}],"reasoning":{"effort":"minimal"}}"#,
        r#"{"model":"grok-4","instructions":"x","stream":true,
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"fix a.rs"}]},{"type":"compaction_trigger"}],
            "tools":[{"type":"function","name":"f","parameters":{"type":"object"}}],"tool_choice":"none"}"#,
        r#"{"model":"grok-4","input":[{"type":"compaction","encrypted_content":"slopmax1:Rml4ZWQgYS5yczsgdGVzdHMgcGFzcy4="},{"type":"compaction","encrypted_content":"gAAAAABencrypted"},{"type":"compaction","encrypted_content":"slopmax1:Rml4ZWQ"},{"type":"message","role":"user","content":[{"type":"input_text","text":"go on"}]}]}"#,
        r#"{"model":"m","input":[{"type":"function_call_output","call_id":"x","output":"r1"},{"type":"message","role":"user","content":"after"},{"type":"function_call","call_id":"y","name":"n","arguments":""},{"type":"message","role":"assistant","content":"said"}],"tool_choice":"auto"}"#,
    ];
    for body in responses {
        out.push((Dialect::Responses, body.to_owned()));
    }
    let chat = [
        r#"{"model":"grok-4","messages":[{"role":"system","content":"Be brief."},{"role":"developer","content":[{"type":"text","text":"Dev"}]},
              {"role":"user","content":[{"type":"text","text":"weather?"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j"}},{"type":"file","file":{"file_data":"data:application/pdf;base64,JVB","filename":"r.pdf"}}]},
              {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":\"Oslo\"}"}},{"id":"call_2","type":"function","function":{"name":"weather"}}]},
              {"role":"tool","tool_call_id":"call_1","content":"rain"},{"role":"tool","tool_call_id":"call_2","content":[{"type":"text","text":"sun"}]},
              {"role":"assistant","content":"Rain and sun."},{"role":"user","content":""},{"role":"user","content":"thanks"}],
            "tools":[{"type":"function","function":{"name":"weather","description":"W","parameters":{"type":"object","properties":{"p":{"type":"number","default":2.50}}}}},{"type":"function","function":{"name":"nop"}}],
            "tool_choice":{"type":"function","function":{"name":"weather"}},"parallel_tool_calls":true,
            "reasoning_effort":"low","stop":"END","stream":true,"stream_options":{"include_usage":true},
            "max_completion_tokens":100,"max_tokens":50,"temperature":1.5,"top_p":1,
            "response_format":{"type":"json_schema","json_schema":{"name":"r","schema":{"type":"object"},"strict":false}},"prompt_cache_key":"k"}"#,
        r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"stop":["a","b"],"max_tokens":50,"tool_choice":"none"}"#,
        r#"{"model":"m","messages":[{"content":"no role"}],"tool_choice":{"type":"function"},"response_format":{"type":"json_object"}}"#,
    ];
    for body in chat {
        out.push((Dialect::Chat, body.to_owned()));
    }
    // serde_json's own errors, word for word.
    let invalid = [
        "", "   ", "x", "{", "[", "[1,]", "[1 2]", "{\"a\":1,}", "{\"a\" 1}", "{\"a\":}", "{1:2}",
        "{\"a\":1 \"b\":2}", "nul", "tru", "fals", "-", "01", "1.", "1.e5", "1e", "1e+", "\"abc",
        "\"a\\x\"", "\"a\\u12\"", "\"a\\u12g4\"", "\"\\ud800\"", "\"\\udc00\"", "\"\\ud800\\u0041\"",
        "\"\\ud800x\"", "\"a\tb\"", "{\"a\":1}x", "{\"a\":1}\n\n  ]", "[1e400]", "[1e999999999999]",
        "[123456789012345678901234567890e300]", "{\"model\":\"m\",}",
        "\n\n{\n  \"model\": tru\n}", "\u{feff}{}", "{\"\u{e9}\": \"\u{fc}\", \"x\": nope}", "[-]", "[1,", "{\"a\"", "{\"a\":1",
        "{,}", "[,1]", "{\"a\":1,\"b\"}", "[\"\\", "[\"\\u", "[1e-]", "[--1]", "[1.5.]", "{\"a\":[}]",
    ];
    let mut invalid: Vec<String> = invalid.iter().map(|s| s.to_string()).collect();
    invalid.push(format!("{}1{}", "[".repeat(127), "]".repeat(127)));
    invalid.push(format!("{}1{}", "[".repeat(128), "]".repeat(128)));
    invalid.push(format!("{{\"a\":{}1{}}}", "[".repeat(130), "]".repeat(130)));
    for body in invalid {
        out.push((Dialect::Chat, body));
    }
    out
}

fn streams() -> Vec<(Dialect, Dialect, &'static str, bool, Vec<&'static str>, bool)> {
    let codex_req = r#"{"model":"grok-4","input":"go","tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"shell"}]}"#;
    let codex_compact = r#"{"model":"grok-4","input":[{"type":"message","role":"user","content":"x"},{"type":"compaction_trigger"}]}"#;
    let claude_req = r#"{"model":"gpt-6-sol","messages":[{"role":"user","content":"hi"}]}"#;
    let chat_req = r#"{"model":"gpt-6-sol","messages":[{"role":"user","content":"hi"}],"stream":true}"#;
    let responses_events = vec![
        r#"{"type":"response.created","response":{"id":"r"}}"#,
        r#"{"type":"response.reasoning_summary_part.added"}"#,
        r#"{"type":"response.reasoning_summary_text.delta","delta":"Plan A"}"#,
        r#"{"type":"response.reasoning_summary_part.added"}"#,
        r#"{"type":"response.reasoning_summary_text.delta","delta":"Plan B"}"#,
        r#"{"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"gAAA"}}"#,
        "   ",
        "not json",
        r#"{"type":"response.output_text.delta","item_id":"m1","delta":"Hi \"there\"\n\u0001é😀"}"#,
        r#"{"type":"response.output_item.done","item":{"type":"message","id":"m1","content":[{"type":"output_text","text":"Hi"}]}}"#,
        r#"{"type":"response.output_item.done","item":{"type":"message","id":"m2","content":[{"type":"output_text","text":"Whole "},{"type":"output_text","text":"text"}]}}"#,
        r#"{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
        r#"{"type":"response.output_item.done","item":{"type":"custom_tool_call","call_id":"c2","name":"apply_patch","input":"*** Begin Patch"}}"#,
        r#"{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c3","name":"empty","arguments":"  "}}"#,
        r#"{"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":7,"total_tokens":107}}}"#,
    ];
    let chat_events = vec![
        r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":"On it.","reasoning_content":"think","reasoning":"more"}}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"shell","arguments":"{\"cmd\""}}]}}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"function":{"name":"apply_patch","arguments":"{\"input\":"}}]}}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"ls\"}"}}]}}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"function":{"arguments":"\"*** Begin\"}"}}]}}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"id":"p1","function":{"name":"apply_patch","arguments":"not json"}}]}}]}"#,
        r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        r#"{"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}"#,
        " [DONE] ",
    ];
    let mut out = Vec::new();
    for client in DIALECTS {
        let (req, include) = match client {
            Dialect::Messages => (claude_req, false),
            Dialect::Responses => (codex_req, false),
            Dialect::Chat => (chat_req, true),
        };
        if client != Dialect::Responses {
            out.push((Dialect::Responses, client, req, include, responses_events.clone(), true));
        }
        if client != Dialect::Chat {
            out.push((Dialect::Chat, client, req, include, chat_events.clone(), true));
        }
    }
    out.push((Dialect::Chat, Dialect::Responses, codex_compact, false, vec![
        r#"{"choices":[{"index":0,"delta":{"content":"Fixed a.rs; "}}]}"#,
        r#"{"choices":[{"index":0,"delta":{"reasoning_content":"hidden","content":"tests pass."}}]}"#,
        r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}"#,
        "[DONE]",
    ], true));
    out.push((Dialect::Chat, Dialect::Responses, codex_compact, false, vec![
        r#"{"choices":[{"index":0,"delta":{"content":"partial"}}]}"#,
        r#"{"error":{"message":"busy","code":503}}"#,
    ], true));
    // Failures and cut streams, for every client.
    for client in DIALECTS {
        let (req, include) = match client {
            Dialect::Messages => (claude_req, false),
            Dialect::Responses => (codex_req, false),
            Dialect::Chat => (chat_req, false),
        };
        if client != Dialect::Responses {
            out.push((Dialect::Responses, client, req, include, vec![
                r#"{"type":"response.output_text.delta","item_id":"m","delta":"Hi"}"#,
                r#"{"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"busy"}}}"#,
            ], true));
            out.push((Dialect::Responses, client, req, include, vec![
                r#"{"type":"error","error":{"type":"usage_limit_reached","message":""}}"#,
            ], true));
            out.push((Dialect::Responses, client, req, include, vec![
                r#"{"type":"response.output_text.delta","item_id":"m","delta":"cut"}"#,
            ], true));
            out.push((Dialect::Responses, client, req, include, vec![
                r#"{"type":"response.output_text.delta","item_id":"m","delta":"long"}"#,
                r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":3,"output_tokens":4}}}"#,
            ], true));
        }
        if client != Dialect::Chat {
            out.push((Dialect::Chat, client, req, include, vec![
                r#"{"choices":[{"index":0,"delta":{"content":"Hi"}}]}"#,
                r#"{"error":{"message":"slow","code":"429"}}"#,
            ], true));
            out.push((Dialect::Chat, client, req, include, vec![
                r#"{"choices":[{"index":0,"delta":{"content":"Hi"}}]}"#,
            ], true));
            out.push((Dialect::Chat, client, req, include, vec![
                r#"{"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"length"}]}"#,
                r#"{"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}"#,
            ], true));
            out.push((Dialect::Chat, client, req, include, vec![
                r#"{"choices":[{"index":0,"delta":{"content":"Hi"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            ], false));
        }
    }
    out
}

fn wholes() -> Vec<(Dialect, Dialect, &'static str, &'static str)> {
    let claude_req = r#"{"model":"gpt-6-sol","messages":[{"role":"user","content":"hi"}]}"#;
    let codex_req = r#"{"model":"grok-4","input":"go","tools":[{"type":"custom","name":"apply_patch"}]}"#;
    let codex_compact = r#"{"model":"grok-4","input":[{"type":"compaction_trigger"}]}"#;
    let chat_req = r#"{"model":"gpt-6-sol","messages":[{"role":"user","content":"hi"}]}"#;
    let responses_body = r#"{"object":"response","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},
        "output":[{"type":"reasoning","encrypted_content":"gAAA"},{"type":"message","id":"m","content":[{"type":"output_text","text":"Partial"}]},
          {"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}],"usage":{"input_tokens":5,"output_tokens":9}}"#;
    let responses_error = r#"{"object":"response","error":{"code":"rate_limit_exceeded","message":"slow"}}"#;
    let chat_body = r#"{"object":"chat.completion","choices":[{"index":0,
        "message":{"role":"assistant","content":"42","reasoning_content":"Think","tool_calls":[{"id":"call_x","type":"function","function":{"name":"apply_patch","arguments":"{\"input\":\"patch\"}"}}]},
        "finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}"#;
    let mut out = Vec::new();
    for client in DIALECTS {
        let req = match client {
            Dialect::Messages => claude_req,
            Dialect::Responses => codex_req,
            Dialect::Chat => chat_req,
        };
        if client != Dialect::Responses {
            out.push((Dialect::Responses, client, req, responses_body));
            out.push((Dialect::Responses, client, req, responses_error));
            out.push((Dialect::Responses, client, req, "{not json"));
        }
        if client != Dialect::Chat {
            out.push((Dialect::Chat, client, req, chat_body));
            out.push((Dialect::Chat, client, req, "{not json"));
        }
    }
    out.push((Dialect::Chat, Dialect::Responses, codex_compact, chat_body));
    out
}

/// Documents read and written back, as serde_json does.
fn roundtrips() -> Vec<Vec<u8>> {
    let docs = [
        r#"["\uDBFF\uDFFF", "\u00e9\u0000\u001f\u007f\u2028", "a\/b\b\f\n\r\t\"\\", -0, -0.0, 0, 0.0, 1.5e-7, 1E2, 1e+2, 5e-324, 2.2250738585072014e-308,
            1.7976931348623157e308, 18446744073709551615, 18446744073709551616, 9223372036854775807, -9223372036854775808,
            -9223372036854775809, -18446744073709551615, -18446744073709551616, 9007199254740991, 9007199254740992, 9007199254740993, -9007199254740993,
            0.1e1, 123.456e-2, 0.30000000000000004, 1234567890123456789012.5, 0.000000000000000000000000000001, 1e22, 1e23, 1e16, 1e15, 1e-5, 1e-6,
            123456789012345678901234567890, 12345678901234567890.123e-5, 1.00000000000000011102230246251565404236316680908203125,
            0.1000000000000000055511151231257827021181583404541015625, 7.0e-10, 100, 1e0, 12e-1, 0e5, 0e999999999999, -0e-5,
            1e-400, 2.5e-324, 4.9406564584124654e-324, true, false, null, {}, [], "", "😀é"]"#,
        r#"[1797693134862315807937289714053034150799341327100378269361737789804449682927647509466490179775872070963302864166928879109465555478519404026306574886715058206819089020007083836762738548458177115317644757302700698555713669596228429148198608349364752927190741684443655107043427115596995080930428801779041744977910]"#,
        r#"[17976931348623158e292, 17976931348623157e292, 1e308, 10e307, 0.1e309, 1.5e308]"#,
        r#"{"b":1,"a":2,"b":3,"__proto__":{"x":1},"constructor":4,"toString":null}"#,
        "  {\"x\" : [ 1 , 2 ] }\n",
    ];
    let mut out: Vec<Vec<u8>> = docs.iter().map(|d| d.as_bytes().to_vec()).collect();
    out.push(b"[\"\xff\"]".to_vec());
    out.push(b"[\"a\xc3\"]".to_vec());
    out.push(b"\xef\xbb\xbf[]".to_vec());
    out.push(b"[1, \xff]".to_vec());
    out
}

fn main() {
    for body in roundtrips() {
        let text: Vec<u8> = body.clone();
        let line_value = match serde_json::from_slice::<Value>(&body) {
            Ok(value) => json!({"kind": "roundtrip", "bytes": text, "out": serde_json::to_string(&value).unwrap()}),
            Err(error) => json!({"kind": "roundtrip", "bytes": text, "error": error.to_string()}),
        };
        line(line_value);
    }
    for (client, body) in requests() {
        match translate::decode(client, body.as_bytes()) {
            Err(error) => line(json!({"kind": "decode", "client": client, "body": body, "error": error})),
            Ok(request) => {
                for upstream in [Dialect::Responses, Dialect::Chat] {
                    let encoded = serde_json::to_string(&translate::encode(upstream, &request)).unwrap();
                    line(json!({"kind": "encode", "client": client, "upstream": upstream, "body": body, "out": encoded}));
                }
            }
        }
    }
    for (upstream, client, req, include, data, finish) in streams() {
        let request = translate::decode(client, req.as_bytes()).unwrap();
        let mut decoder = Decoder::new(upstream, &request);
        let mut events = Vec::new();
        for d in &data {
            decoder.data(d.as_bytes(), &mut events);
        }
        if finish {
            decoder.finish(&mut events);
        }
        let mut encoder = Encoder::for_request(client, &request, "m", include);
        let mut out = Vec::new();
        for event in &events {
            encoder.event(event, &mut out);
        }
        let answer = Answer::collect(events.clone());
        let whole = serde_json::to_string(&translate::whole(client, &request, &answer, "m")).unwrap();
        line(json!({"kind": "stream", "upstream": upstream, "client": client, "request": req, "include_usage": include,
            "data": data, "finish": finish, "events": normalize(&format!("{events:?}")),
            "out": normalize(&String::from_utf8(out).unwrap()), "whole": normalize(&whole)}));
    }
    for (upstream, client, req, body) in wholes() {
        let request = translate::decode(client, req.as_bytes()).unwrap();
        let mut decoder = Decoder::new(upstream, &request);
        let mut events = Vec::new();
        decoder.whole(body.as_bytes(), &mut events);
        let answer = Answer::collect(events.clone());
        let whole = serde_json::to_string(&translate::whole(client, &request, &answer, "m")).unwrap();
        line(json!({"kind": "whole", "upstream": upstream, "client": client, "request": req, "body": body,
            "events": normalize(&format!("{events:?}")), "whole": normalize(&whole)}));
    }
    // Encoders fed events directly, including the ones decoders never make.
    let call = |kind: &str| -> Event {
        Event::Call(slopmax_wire::ir::Call {
            id: "call_7".into(), name: "f".into(), input: if kind == "freeform" { "raw \"input\"".into() } else { "".into() },
            kind: if kind == "freeform" { slopmax_wire::ir::ToolKind::Freeform } else { slopmax_wire::ir::ToolKind::Function },
        })
    };
    let usage = slopmax_wire::Usage { requests: 1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 30, cache_write_tokens: 2 };
    let scripts: Vec<(&str, Vec<Event>)> = vec![
        ("reasoning-text-calls", vec![Event::Reasoning("Think".into()), Event::State("s".into()), Event::Text("A".into()), Event::Reasoning("More".into()),
            Event::Text("B".into()), call("function"), call("freeform"), Event::Text("C".into()), Event::Done { stop: Stop::End, usage }]),
        ("sequence", vec![Event::Text("x".into()), Event::Done { stop: Stop::Sequence, usage }]),
        ("filtered", vec![Event::Done { stop: Stop::Filtered, usage }]),
        ("length", vec![Event::Reasoning("r".into()), Event::Done { stop: Stop::Length, usage }]),
        ("errors", vec![Event::Text("t".into()), Event::Error(Failure { status: 413, message: "big".into() })]),
        ("error-401", vec![Event::Error(Failure { status: 401, message: "who".into() })]),
        ("error-400", vec![Event::Error(Failure { status: 400, message: "bad".into() })]),
        ("error-503", vec![Event::Error(Failure { status: 503, message: "busy".into() })]),
        ("error-404", vec![Event::Error(Failure { status: 404, message: "gone".into() })]),
        ("error-403", vec![Event::Error(Failure { status: 403, message: "no".into() })]),
        ("error-500", vec![Event::Error(Failure { status: 500, message: "oops".into() })]),
    ];
    for (name, events) in scripts {
        for client in DIALECTS {
            for compact in [false, true] {
                if compact && client != Dialect::Responses {
                    continue;
                }
                let request = slopmax_wire::ir::Request { compact, ..Default::default() };
                for include in [false, true] {
                    let mut encoder = Encoder::for_request(client, &request, "m", include);
                    let mut out = Vec::new();
                    for event in &events {
                        encoder.event(event, &mut out);
                    }
                    let answer = Answer::collect(events.clone());
                    let whole = serde_json::to_string(&translate::whole(client, &request, &answer, "m")).unwrap();
                    line(json!({"kind": "script", "name": name, "client": client, "compact": compact, "include_usage": include,
                        "out": normalize(&String::from_utf8(out).unwrap()), "whole": normalize(&whole)}));
                }
            }
        }
    }
    // What a stream says about the account.
    let observed = [
        r#"{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":2,"output_tokens":1}}}"#,
        r#"{"type":"message_delta","usage":{"output_tokens":9,"input_tokens":0}}"#,
        r#"{"type":"message","usage":{"input_tokens":3,"output_tokens":4.0}}"#,
        r#"{"type":"error","error":{"type":"rate_limit_error"}}"#,
        r#"{"type":"error","error":{"type":"overloaded_error"}}"#,
        r#"{"type":"response.created"}"#,
        r#"{"type":"response.in_progress"}"#,
        r#"{"type":"response.queued"}"#,
        r#"{"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3,"input_tokens_details":{"cached_tokens":20}}}}"#,
        r#"{"type":"response.done","response":{"usage":{"input_tokens":12,"output_tokens":3}}}"#,
        r#"{"object":"response","usage":{"input_tokens":7,"output_tokens":1}}"#,
        r#"{"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}"#,
        r#"{"type":"response.failed","response":{"error":null},"error":{"code":"usage_limit_exceeded"}}"#,
        r#"{"type":"error","error":{"code":null,"type":"usage_limit_reached"}}"#,
        r#"{"type":"error","error":{"type":"slow_down"}}"#,
        r#"{"type":"error","code":"rate_limit_exceeded"}"#,
        r#"{"type":"response.failed","response":{"error":{"code":"context_length_exceeded"}}}"#,
        r#"{"type":"response.output_text.delta"}"#,
        r#"{"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":100}}}"#,
        r#"{"usage":null}"#,
        r#"[1,2]"#,
    ];
    for dialect in DIALECTS {
        for event in observed {
            let value: Value = serde_json::from_str(event).unwrap();
            let mut outcome = Outcome::default();
            dialect.observe(&value, &mut outcome);
            let u = outcome.usage;
            line(json!({"kind": "observe", "dialect": dialect, "event": event,
                "usage": [u.requests, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens],
                "exhausted": outcome.exhausted, "opening": format!("{:?}", dialect.opening(&value))}));
        }
        let now = Timestamp::from_millisecond(1_000_500).unwrap();
        for until in [Timestamp::from_millisecond(4_600_999).unwrap(), Timestamp::from_second(900).unwrap(), now] {
            let (body, headers) = dialect.limit_reached("all spent", until, now);
            line(json!({"kind": "limit", "dialect": dialect, "now": 1_000_500, "until": until.as_millisecond(),
                "body": serde_json::to_string(&body).unwrap(), "headers": headers}));
        }
        line(json!({"kind": "error", "dialect": dialect, "body": serde_json::to_string(&dialect.error("api_error", "x \"y\"")).unwrap()}));
    }
}
