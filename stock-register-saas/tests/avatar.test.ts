import { test } from "node:test";
import assert from "node:assert/strict";
import { AVATAR_MAX_CHARS, avatarError } from "../lib/avatar.ts";

test("avatarError accepts small png/jpeg/webp data URLs", () => {
  assert.equal(avatarError("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="), null);
  assert.equal(avatarError("data:image/png;base64,iVBORw0KGgo="), null);
  assert.equal(avatarError("data:image/webp;base64,UklGRg=="), null);
});

test("avatarError rejects other types, scripts, URLs and oversize images", () => {
  assert.ok(avatarError("data:image/svg+xml;base64,PHN2Zz4="));
  assert.ok(avatarError("data:text/html;base64,PGgxPg=="));
  assert.ok(avatarError("javascript:alert(1)"));
  assert.ok(avatarError("https://example.com/me.jpg"));
  assert.ok(avatarError("data:image/png;base64,abc def"));
  assert.ok(avatarError("data:image/png;base64," + "A".repeat(AVATAR_MAX_CHARS)));
});
