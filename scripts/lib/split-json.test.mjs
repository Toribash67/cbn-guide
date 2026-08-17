import { test } from "node:test";
import assert from "node:assert/strict";
import { topLevelElementRanges } from "./split-json.mjs";

test("array of objects on separate lines", () => {
  const text = '[\n  {"a":1},\n  {"b":2}\n]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});

test("multi-line object element", () => {
  const text = '[\n{\n"a":1\n},\n{"b":2}\n]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 4 },
    { startLine: 5, endLine: 5 },
  ]);
});

test("single top-level object", () => {
  const text = '{\n"x":1\n}';
  assert.deepEqual(topLevelElementRanges(text), [{ startLine: 1, endLine: 3 }]);
});

test("nested brackets and braces do not create elements", () => {
  const text = '[{"a":[1,2],"b":{"c":3}}]';
  assert.deepEqual(topLevelElementRanges(text), [{ startLine: 1, endLine: 1 }]);
});

test("braces inside strings are ignored", () => {
  const text = '[\n{"a":"}{"},\n{"b":"]["}\n]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});

test("leading BOM is tolerated", () => {
  const text = '﻿[\n{"a":1}\n]';
  assert.deepEqual(topLevelElementRanges(text), [{ startLine: 2, endLine: 2 }]);
});

test("bare primitive numbers in array", () => {
  const text = "[1, 2, 3]";
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
  ]);
});

test("mixed objects and primitives in array", () => {
  const text = '[{"a":1},"foo",{"b":2}]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
  ]);
});

test("multi-line primitive array", () => {
  const text = "[\n  1,\n  2\n]";
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});
