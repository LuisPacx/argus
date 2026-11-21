import { describe, expect, it } from "vitest";
import { findRawHrefs, scanWarroom } from "./lint-links.mjs";

const tpl = (body: string) => `<script setup lang="ts">\nconst x = "";\n</script>\n<template>\n${body}\n</template>\n`;

describe("argus/no-raw-href", () => {
  it.each([
    ['<a :href="x">t</a>'],
    ['<a v-bind:href="x">t</a>'],
    ['<a :href="s.url" :title="s.url">t</a>'],
    ['<a :href="`${x}`">t</a>'],
    ['<a v-bind="{ href: x }">t</a>'],
    ['<a :[attr]="x">t</a>'],
    ['<NuxtLink :href="x">t</NuxtLink>'],
    ['<ul><li v-for="s in list"><a v-if="s.href" :href="s.href">t</a></li></ul>'],
  ])("fails a raw bound href: %s", (body) => {
    expect(findRawHrefs(tpl(body)).length).toBeGreaterThan(0);
  });

  it.each([
    ['<a :href="safeHttpUrl(x)">t</a>'],
    ['<a :href="safeHttpUrl(s.href) ?? undefined">t</a>'],
    ['<a href="https://example.com/">t</a>'],
    ['<a :title="x" href="#top">t</a>'],
    ['<UrlLink :href="x" label="t" />'],
    ['<NuxtLink :to="x">t</NuxtLink>'],
  ])("passes: %s", (body) => {
    expect(findRawHrefs(tpl(body))).toEqual([]);
  });

  it("reports the line of the offending attribute", () => {
    expect(findRawHrefs(tpl("<p>ok</p>\n<a :href=\"x\">t</a>"))[0]?.line).toBe(6);
  });

  it("passes on the current War Room tree", () => {
    expect(scanWarroom()).toEqual([]);
  });
});
