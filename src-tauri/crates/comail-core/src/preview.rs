//! Safe in-app attachment previews. Documents are converted to inert data
//! (sanitized HTML, plain text, cell grids) on the Rust side so the webview
//! never runs untrusted parsers or scripts; binaries the frontend renders
//! itself (images, PDFs via pdf.js) are passed through as base64.

use base64::Engine;
use serde::Serialize;
use std::io::{Cursor, Read};

/// Hard cap on the attachment size we will load for preview.
pub const MAX_PREVIEW_BYTES: usize = 25 * 1024 * 1024;
/// Cap on plain-text previews (chars) so a giant log can't stall the UI.
const MAX_TEXT_CHARS: usize = 200_000;
const MAX_SHEETS: usize = 20;
const MAX_ROWS: usize = 1_000;
const MAX_COLS: usize = 64;
const MAX_SLIDES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPreview {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidePreview {
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AttachmentPreview {
    /// Raster/vector image, delivered as a data URI (rendered in an <img>,
    /// where SVG scripts never execute).
    Image { data_uri: String },
    /// PDF bytes; the frontend rasterizes pages with bundled pdf.js.
    Pdf { base64: String },
    /// Ammonia-sanitized HTML (docx, markdown, html attachments), rendered
    /// inside the same sandboxed iframe used for email bodies.
    Html { html: String },
    /// Spreadsheet / CSV cell grid.
    Sheet { sheets: Vec<SheetPreview> },
    /// Slide-deck text extraction.
    Slides { slides: Vec<SlidePreview> },
    /// Plain text / source code.
    Text { text: String, truncated: bool },
    /// Not previewable in-app; the UI offers "open externally".
    Unsupported { reason: String },
}

/// Build a preview from raw attachment bytes. Never fails: anything we can't
/// parse degrades to `Unsupported` so the UI can fall back to the OS opener.
pub fn build_preview(
    bytes: &[u8],
    filename: Option<&str>,
    mime: Option<&str>,
) -> AttachmentPreview {
    if bytes.len() > MAX_PREVIEW_BYTES {
        return AttachmentPreview::Unsupported {
            reason: "too_large".into(),
        };
    }
    let ext = filename
        .and_then(|f| f.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .unwrap_or_default();
    let mime = mime.unwrap_or("").to_ascii_lowercase();

    match format_of(&ext, &mime) {
        Format::Image(img_mime) => AttachmentPreview::Image {
            data_uri: format!(
                "data:{};base64,{}",
                img_mime,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        },
        Format::Pdf => AttachmentPreview::Pdf {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
        Format::Docx => docx_preview(bytes),
        Format::Pptx => pptx_preview(bytes),
        Format::Sheet => sheet_preview(bytes),
        Format::Csv(delim) => csv_preview(bytes, delim),
        Format::Markdown => markdown_preview(bytes),
        Format::Html => AttachmentPreview::Html {
            html: crate::mime::sanitize_html(&String::from_utf8_lossy(bytes)),
        },
        Format::Text => text_preview(bytes),
        Format::Unknown => {
            // Heuristic: bytes that decode as valid UTF-8 without control
            // garbage still make a useful text preview (README, LICENSE, ...).
            match std::str::from_utf8(bytes) {
                Ok(s) if !looks_binary(s) => text_preview(bytes),
                _ => AttachmentPreview::Unsupported {
                    reason: "unsupported_type".into(),
                },
            }
        }
    }
}

enum Format {
    Image(&'static str),
    Pdf,
    Docx,
    Pptx,
    Sheet,
    Csv(u8),
    Markdown,
    Html,
    Text,
    Unknown,
}

fn format_of(ext: &str, mime: &str) -> Format {
    match ext {
        "png" => return Format::Image("image/png"),
        "jpg" | "jpeg" => return Format::Image("image/jpeg"),
        "gif" => return Format::Image("image/gif"),
        "webp" => return Format::Image("image/webp"),
        "bmp" => return Format::Image("image/bmp"),
        "svg" => return Format::Image("image/svg+xml"),
        "ico" => return Format::Image("image/x-icon"),
        "avif" => return Format::Image("image/avif"),
        "pdf" => return Format::Pdf,
        "docx" => return Format::Docx,
        "pptx" | "ppsx" => return Format::Pptx,
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => return Format::Sheet,
        "csv" => return Format::Csv(b','),
        "tsv" => return Format::Csv(b'\t'),
        "md" | "markdown" => return Format::Markdown,
        "html" | "htm" => return Format::Html,
        "txt" | "log" | "json" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf"
        | "rs" | "py" | "js" | "ts" | "tsx" | "jsx" | "java" | "c" | "cpp" | "h" | "hpp" | "go"
        | "rb" | "sh" | "css" | "sql" | "diff" | "patch" | "ics" | "eml" => return Format::Text,
        _ => {}
    }
    // No (known) extension - fall back to the declared MIME type.
    if let Some(rest) = mime.strip_prefix("image/") {
        // Only image types browsers render; anything else stays unsupported.
        if matches!(
            rest,
            "png" | "jpeg" | "gif" | "webp" | "bmp" | "svg+xml" | "x-icon" | "avif"
        ) {
            return Format::Image(match rest {
                "png" => "image/png",
                "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "svg+xml" => "image/svg+xml",
                "x-icon" => "image/x-icon",
                _ => "image/avif",
            });
        }
        return Format::Unknown;
    }
    match mime {
        "application/pdf" => Format::Pdf,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Format::Docx,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Format::Pptx,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.ms-excel"
        | "application/vnd.oasis.opendocument.spreadsheet" => Format::Sheet,
        "text/csv" => Format::Csv(b','),
        "text/tab-separated-values" => Format::Csv(b'\t'),
        "text/markdown" => Format::Markdown,
        "text/html" => Format::Html,
        m if m.starts_with("text/") => Format::Text,
        "application/json" | "application/xml" => Format::Text,
        _ => Format::Unknown,
    }
}

fn looks_binary(s: &str) -> bool {
    s.chars()
        .take(4096)
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
}

fn text_preview(bytes: &[u8]) -> AttachmentPreview {
    let s = String::from_utf8_lossy(bytes);
    let truncated = s.chars().count() > MAX_TEXT_CHARS;
    AttachmentPreview::Text {
        text: s.chars().take(MAX_TEXT_CHARS).collect(),
        truncated,
    }
}

fn markdown_preview(bytes: &[u8]) -> AttachmentPreview {
    let src: String = String::from_utf8_lossy(bytes)
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect();
    let mut opts = pulldown_cmark::Options::empty();
    opts.insert(pulldown_cmark::Options::ENABLE_TABLES);
    opts.insert(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
    opts.insert(pulldown_cmark::Options::ENABLE_TASKLISTS);
    let parser = pulldown_cmark::Parser::new_ext(&src, opts);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    AttachmentPreview::Html {
        html: crate::mime::sanitize_html(&html),
    }
}

fn csv_preview(bytes: &[u8], delim: u8) -> AttachmentPreview {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_reader(bytes);
    let mut rows = Vec::new();
    let mut truncated = false;
    for rec in rdr.records() {
        let Ok(rec) = rec else { break };
        if rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        if rec.len() > MAX_COLS {
            truncated = true;
        }
        rows.push(rec.iter().take(MAX_COLS).map(|c| c.to_string()).collect());
    }
    AttachmentPreview::Sheet {
        sheets: vec![SheetPreview {
            name: String::new(),
            rows,
            truncated,
        }],
    }
}

fn sheet_preview(bytes: &[u8]) -> AttachmentPreview {
    let cursor = Cursor::new(bytes.to_vec());
    let mut workbook = match calamine::open_workbook_auto_from_rs(cursor) {
        Ok(wb) => wb,
        Err(e) => return unsupported_parse(&e.to_string()),
    };
    use calamine::Reader;
    let names: Vec<String> = workbook.sheet_names().to_vec();
    let mut sheets = Vec::new();
    for name in names.into_iter().take(MAX_SHEETS) {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue;
        };
        let mut rows = Vec::new();
        let mut truncated = false;
        for row in range.rows() {
            if rows.len() >= MAX_ROWS {
                truncated = true;
                break;
            }
            if row.len() > MAX_COLS {
                truncated = true;
            }
            rows.push(
                row.iter()
                    .take(MAX_COLS)
                    .map(|c| match c {
                        calamine::Data::Empty => String::new(),
                        other => other.to_string(),
                    })
                    .collect(),
            );
        }
        sheets.push(SheetPreview {
            name,
            rows,
            truncated,
        });
    }
    if sheets.is_empty() {
        return unsupported_parse("no sheets");
    }
    AttachmentPreview::Sheet { sheets }
}

fn unsupported_parse(detail: &str) -> AttachmentPreview {
    tracing::debug!(detail, "attachment preview parse failed");
    AttachmentPreview::Unsupported {
        reason: "parse_failed".into(),
    }
}

fn read_zip_entry(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut file = zip.by_name(name).ok()?;
    // Zip-bomb guard: refuse entries that inflate past the preview cap.
    if file.size() > MAX_PREVIEW_BYTES as u64 * 4 {
        return None;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// DOCX -> simple HTML: paragraphs, Heading styles, list items, and tables.
/// Run-level formatting (bold/italic per run) is intentionally dropped; the
/// goal is a fast, safe, readable preview, not fidelity.
fn docx_preview(bytes: &[u8]) -> AttachmentPreview {
    let Some(doc) = read_zip_entry(bytes, "word/document.xml") else {
        return unsupported_parse("missing word/document.xml");
    };
    let mut reader = quick_xml::Reader::from_reader(doc.as_slice());
    reader.config_mut().trim_text(false);

    let mut html = String::new();
    let mut para = String::new();
    let mut para_style: Option<String> = None;
    let mut in_list = false;
    let mut numbered = false;
    // Table state: cells accumulate paragraph text; depth guards nesting.
    let mut table_depth = 0usize;
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut buf = Vec::new();

    macro_rules! close_list {
        () => {
            if in_list {
                html.push_str("</ul>");
                in_list = false;
            }
        };
    }

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(e)) => match e.local_name().as_ref() {
                b"p" => {
                    para.clear();
                    para_style = None;
                    numbered = false;
                }
                b"tbl" => {
                    table_depth += 1;
                    if table_depth == 1 {
                        close_list!();
                        html.push_str("<table border=\"1\" cellpadding=\"4\">");
                    }
                }
                b"tr" if table_depth == 1 => row.clear(),
                b"tc" if table_depth == 1 => cell.clear(),
                _ => {}
            },
            Ok(quick_xml::events::Event::Empty(e)) => match e.local_name().as_ref() {
                b"pStyle" => {
                    if let Some(v) = attr_val(&e, b"val") {
                        para_style = Some(v);
                    }
                }
                b"numPr" => numbered = true,
                b"br" | b"cr" => para.push('\n'),
                b"tab" => para.push('\t'),
                _ => {}
            },
            Ok(quick_xml::events::Event::Text(t)) => {
                if let Ok(txt) = t.unescape() {
                    para.push_str(&txt);
                }
            }
            Ok(quick_xml::events::Event::End(e)) => match e.local_name().as_ref() {
                b"p" => {
                    let text = escape_html(para.trim()).replace('\n', "<br>");
                    if table_depth >= 1 {
                        if !text.is_empty() {
                            if !cell.is_empty() {
                                cell.push_str("<br>");
                            }
                            cell.push_str(&text);
                        }
                    } else if numbered {
                        if !in_list {
                            html.push_str("<ul>");
                            in_list = true;
                        }
                        html.push_str(&format!("<li>{text}</li>"));
                    } else {
                        close_list!();
                        match heading_level(para_style.as_deref()) {
                            Some(level) if !text.is_empty() => {
                                html.push_str(&format!("<h{level}>{text}</h{level}>"));
                            }
                            _ if !text.is_empty() => html.push_str(&format!("<p>{text}</p>")),
                            _ => {}
                        }
                    }
                }
                b"tc" if table_depth == 1 => row.push(std::mem::take(&mut cell)),
                b"tr" if table_depth == 1 => {
                    html.push_str("<tr>");
                    for c in row.drain(..) {
                        html.push_str(&format!("<td>{c}</td>"));
                    }
                    html.push_str("</tr>");
                }
                b"tbl" => {
                    if table_depth == 1 {
                        html.push_str("</table>");
                    }
                    table_depth = table_depth.saturating_sub(1);
                }
                _ => {}
            },
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => return unsupported_parse("bad document.xml"),
            _ => {}
        }
        buf.clear();
    }
    if in_list {
        html.push_str("</ul>");
    }
    if html.is_empty() {
        return unsupported_parse("empty docx");
    }
    AttachmentPreview::Html {
        html: crate::mime::sanitize_html(&html),
    }
}

fn heading_level(style: Option<&str>) -> Option<u8> {
    let s = style?;
    if s.eq_ignore_ascii_case("title") {
        return Some(1);
    }
    let n = s
        .strip_prefix("Heading")
        .or_else(|| s.strip_prefix("heading"))?
        .parse::<u8>()
        .ok()?;
    (1..=6).contains(&n).then_some(n)
}

fn attr_val(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        (a.key.local_name().as_ref() == name).then(|| String::from_utf8_lossy(&a.value).to_string())
    })
}

/// PPTX -> per-slide text lines (each `a:p` paragraph becomes one line).
fn pptx_preview(bytes: &[u8]) -> AttachmentPreview {
    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return unsupported_parse("not a zip");
    };
    // Slide entries aren't ordered in the archive; collect and sort by number.
    let mut slide_names: Vec<(u32, String)> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .filter_map(|name| {
            let n: u32 = name
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((n, name))
        })
        .collect();
    slide_names.sort_unstable();
    if slide_names.is_empty() {
        return unsupported_parse("no slides");
    }

    let mut slides = Vec::new();
    for (_, name) in slide_names.into_iter().take(MAX_SLIDES) {
        let Some(xml) = read_zip_entry(bytes, &name) else {
            continue;
        };
        let mut reader = quick_xml::Reader::from_reader(xml.as_slice());
        let mut lines = Vec::new();
        let mut line = String::new();
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(quick_xml::events::Event::Text(t)) => {
                    if let Ok(txt) = t.unescape() {
                        line.push_str(&txt);
                    }
                }
                Ok(quick_xml::events::Event::End(e)) if e.local_name().as_ref() == b"p" => {
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        lines.push(trimmed);
                    }
                    line.clear();
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
        slides.push(SlidePreview { lines });
    }
    AttachmentPreview::Slides { slides }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn image_becomes_data_uri() {
        let p = build_preview(&[0x89, 0x50, 0x4e, 0x47], Some("pic.PNG"), None);
        match p {
            AttachmentPreview::Image { data_uri } => {
                assert!(data_uri.starts_with("data:image/png;base64,"))
            }
            other => panic!("expected image, got {other:?}"),
        }
    }

    #[test]
    fn pdf_passes_base64() {
        let p = build_preview(b"%PDF-1.7", None, Some("application/pdf"));
        assert!(matches!(p, AttachmentPreview::Pdf { .. }));
    }

    #[test]
    fn markdown_renders_sanitized_html() {
        let p = build_preview(
            b"# Hi\n\n*em*\n\n<script>alert(1)</script>",
            Some("readme.md"),
            None,
        );
        match p {
            AttachmentPreview::Html { html } => {
                assert!(html.contains("<h1>Hi</h1>"));
                assert!(html.contains("<em>em</em>"));
                assert!(!html.contains("script"));
            }
            other => panic!("expected html, got {other:?}"),
        }
    }

    #[test]
    fn html_attachment_is_sanitized() {
        let p = build_preview(
            b"<p onclick=\"x()\">ok</p><script>bad()</script>",
            Some("page.html"),
            None,
        );
        match p {
            AttachmentPreview::Html { html } => {
                assert!(html.contains("<p>ok</p>"));
                assert!(!html.contains("onclick") && !html.contains("script"));
            }
            other => panic!("expected html, got {other:?}"),
        }
    }

    #[test]
    fn csv_parses_grid() {
        let p = build_preview(b"a,b,\"c,d\"\n1,2,3\n", Some("data.csv"), None);
        match p {
            AttachmentPreview::Sheet { sheets } => {
                assert_eq!(sheets[0].rows[0], vec!["a", "b", "c,d"]);
                assert_eq!(sheets[0].rows[1], vec!["1", "2", "3"]);
            }
            other => panic!("expected sheet, got {other:?}"),
        }
    }

    #[test]
    fn docx_paragraphs_headings_tables() {
        const DOC: &str = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
  <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world &amp; &lt;tag&gt;</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item one</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
 </w:body>
</w:document>"#;
        let bytes = zip_with(&[("word/document.xml", DOC)]);
        let p = build_preview(&bytes, Some("doc.docx"), None);
        match p {
            AttachmentPreview::Html { html } => {
                assert!(html.contains("<h1>Title</h1>"), "html: {html}");
                assert!(
                    html.contains("<p>Hello world &amp; &lt;tag&gt;</p>"),
                    "html: {html}"
                );
                assert!(html.contains("<li>item one</li>"), "html: {html}");
                assert!(html.contains("<td>A1</td><td>B1</td>"), "html: {html}");
            }
            other => panic!("expected html, got {other:?}"),
        }
    }

    #[test]
    fn pptx_extracts_slide_lines_in_order() {
        const S: &str = r#"<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree><p:sp><p:txBody>
   <a:p><a:r><a:t>SLIDE_TXT</a:t></a:r></a:p>
 </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
        let bytes = zip_with(&[
            ("ppt/slides/slide2.xml", &S.replace("SLIDE_TXT", "second")),
            ("ppt/slides/slide1.xml", &S.replace("SLIDE_TXT", "first")),
        ]);
        let p = build_preview(&bytes, Some("deck.pptx"), None);
        match p {
            AttachmentPreview::Slides { slides } => {
                assert_eq!(slides.len(), 2);
                assert_eq!(slides[0].lines, vec!["first"]);
                assert_eq!(slides[1].lines, vec!["second"]);
            }
            other => panic!("expected slides, got {other:?}"),
        }
    }

    #[test]
    fn unknown_binary_is_unsupported_but_utf8_previews_as_text() {
        let p = build_preview(&[0u8, 159, 146, 150], Some("blob.bin"), None);
        assert!(matches!(p, AttachmentPreview::Unsupported { .. }));
        let p = build_preview(b"plain readme contents", Some("LICENSE"), None);
        assert!(matches!(p, AttachmentPreview::Text { .. }));
    }

    #[test]
    fn oversized_is_rejected() {
        let p = build_preview(&vec![0u8; MAX_PREVIEW_BYTES + 1], Some("big.pdf"), None);
        match p {
            AttachmentPreview::Unsupported { reason } => assert_eq!(reason, "too_large"),
            other => panic!("expected unsupported, got {other:?}"),
        }
    }

    #[test]
    fn text_truncates() {
        let big = "x".repeat(MAX_TEXT_CHARS + 10);
        let p = build_preview(big.as_bytes(), Some("big.log"), None);
        match p {
            AttachmentPreview::Text { text, truncated } => {
                assert!(truncated);
                assert_eq!(text.chars().count(), MAX_TEXT_CHARS);
            }
            other => panic!("expected text, got {other:?}"),
        }
    }
}
