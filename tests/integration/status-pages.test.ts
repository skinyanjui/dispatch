import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorPage from "../../src/app/error";
import GlobalError from "../../src/app/global-error";
import NotFound from "../../src/app/not-found";
import { errorDigest } from "../../src/lib/ui-error";

test("only an opaque digest is ever taken from an error", () => {
  assert.equal(errorDigest({ digest: "1234abcd" }), "1234abcd");
  assert.equal(
    errorDigest(new Error("load 3f2a… for carrier X failed")),
    undefined,
  );
  assert.equal(
    errorDigest({ digest: "has spaces and <b>markup</b>" }),
    undefined,
  );
  assert.equal(errorDigest({ digest: "x".repeat(200) }), undefined);
  assert.equal(errorDigest(null), undefined);
  assert.equal(errorDigest("boom"), undefined);
});

test("the error page announces itself, offers a retry and shows no message text", () => {
  const html = renderToStaticMarkup(
    createElement(ErrorPage, {
      error: Object.assign(new Error("secret record 42 leaked"), {
        digest: "d1g3st",
      }),
      retry: () => undefined,
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.match(html, /d1g3st/);
  assert.doesNotMatch(html, /secret record/);
});

test("the global error page carries its own document and a retry", () => {
  const html = renderToStaticMarkup(
    createElement(GlobalError, { error: {}, retry: () => undefined }),
  );
  assert.match(html, /<html lang="en">/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
});

test("the 404 page does not say whether a record exists", () => {
  const html = renderToStaticMarkup(createElement(NotFound));
  assert.match(html, /We can.t find that page/);
  assert.match(html, /not available to\s+your account/);
  assert.match(html, /href="\/"/);
});
