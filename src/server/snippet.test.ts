import assert from "node:assert/strict";
import test from "node:test";

import { BODY_CHAR_CAP, SNIPPET_LENGTH, htmlToText, makeSnippet, truncateBody } from "./snippet";

test("htmlToText strips script and style blocks including their content", () => {
  const html =
    "<head><title>ignored</title></head>" +
    "<style>body { color: red; }</style>" +
    "<p>Hello</p>" +
    '<script type="text/javascript">alert("boom");</script>' +
    "<p>world</p>";
  assert.equal(htmlToText(html), "Hello world");
});

test("htmlToText turns block closers and <br> into breaks, then collapses", () => {
  assert.equal(htmlToText("<div>one</div><p>two</p>three<br>four"), "one two three four");
});

test("htmlToText decodes entities, including numeric and hex", () => {
  assert.equal(
    htmlToText("Tom &amp; Jerry &#65;&#x42; &quot;hi&quot; &#39;yo&#39;"),
    'Tom & Jerry AB "hi" \'yo\'',
  );
  assert.equal(htmlToText("a&nbsp;b"), "a b");
});

test("htmlToText decodes after tag stripping so escaped markup stays inert", () => {
  // The decoded "<script>" is literal text by then; its content must survive.
  assert.equal(htmlToText("&lt;script&gt;alert(1)&lt;/script&gt;"), "<script>alert(1)</script>");
});

test("makeSnippet keeps exactly SNIPPET_LENGTH chars and slices beyond it", () => {
  const exact = "a".repeat(SNIPPET_LENGTH);
  assert.equal(makeSnippet(exact, null), exact);
  const over = "b".repeat(SNIPPET_LENGTH + 1);
  assert.equal(makeSnippet(over, null), "b".repeat(SNIPPET_LENGTH));
});

test("makeSnippet falls back to html when text is empty", () => {
  assert.equal(makeSnippet(null, "<p>From the html body</p>"), "From the html body");
  assert.equal(makeSnippet("   ", "<p>From the html body</p>"), "From the html body");
  assert.equal(makeSnippet("text  wins", "<p>not this</p>"), "text wins");
  assert.equal(makeSnippet(null, null), null);
  assert.equal(makeSnippet("  ", "<style>.x{}</style>"), null);
});

test("truncateBody caps at BODY_CHAR_CAP", () => {
  const atCap = "a".repeat(BODY_CHAR_CAP);
  assert.deepEqual(truncateBody(atCap), { value: atCap, truncated: false });

  const overCap = truncateBody("a".repeat(BODY_CHAR_CAP + 1));
  assert.equal(overCap.truncated, true);
  assert.equal(overCap.value?.length, BODY_CHAR_CAP);
});

test("truncateBody passes null and undefined through", () => {
  assert.deepEqual(truncateBody(null), { value: null, truncated: false });
  assert.deepEqual(truncateBody(undefined), { value: null, truncated: false });
});
