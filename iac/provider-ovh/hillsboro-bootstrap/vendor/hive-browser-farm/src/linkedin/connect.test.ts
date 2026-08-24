import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTE_MAX_CHARS } from "./connect.ts";
import { CONTRACT_VERSION, parseAction, isWriteAction } from "../actions/contract.ts";

const url = "https://www.linkedin.com/in/someone/";

test("an over-long note is rejected before any browser work", () => {
  // The cap is client-side on LinkedIn's side too; catching it here keeps a
  // caller error from consuming an invite against the weekly cap.
  assert.equal(NOTE_MAX_CHARS, 200);
  assert.throws(() => parseAction(
    { type: "send_connection_request", profileUrl: url, note: "x".repeat(201) }, CONTRACT_VERSION));
  assert.doesNotThrow(() => parseAction(
    { type: "send_connection_request", profileUrl: url, note: "x".repeat(200) }, CONTRACT_VERSION));
});

test("inviting is gated as a write", () => {
  assert.equal(isWriteAction(parseAction({ type: "send_connection_request", profileUrl: url }, CONTRACT_VERSION)), true);
});

test("a note is optional — note-less invites are the fallback when quota runs out", () => {
  const a = parseAction({ type: "send_connection_request", profileUrl: url }, CONTRACT_VERSION);
  assert.equal(a.type === "send_connection_request" && a.note, undefined);
});

test("the invite target must be a LinkedIn profile URL", () => {
  assert.throws(() => parseAction({ type: "send_connection_request", profileUrl: "https://evil.example.com/in/x/" }, CONTRACT_VERSION));
});

test("the owner name is recoverable from the document title", () => {
  // Profile pages carry no h1 on the current UI, so the title is the only
  // source. LinkedIn prefixes it with an unread count, and leaving that in
  // makes every owner-scoped aria-label match fail — which fails closed as
  // "cannot_connect" and silently makes the account look unable to invite.
  const owner = (title: string): string =>
    title.replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  assert.equal(owner("(2) Ada Lovelace | LinkedIn"), "Ada Lovelace");
  assert.equal(owner("Ada Lovelace | LinkedIn"), "Ada Lovelace");
  assert.equal(owner("(17) Grace Hopper | LinkedIn"), "Grace Hopper");
});
