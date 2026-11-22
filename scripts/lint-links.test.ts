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
    ['<a :href="safeHttpUrl(a) || evil(b)">t</a>'],
    ['<a :href="safeHttpUrl(a) ?? evil(b)">t</a>'],
    ['<a :href="evil(safeHttpUrl(a))">t</a>'],
    ['<a :href="safeHttpUrl(a), evil(b)">t</a>'],
    ['<a :href="x ? safeHttpUrl(a) : b">t</a>'],
    ['<a :HREF="x">t</a>'],
    ['<a :Href="x">t</a>'],
    ['<a v-bind:HREF="x">t</a>'],
    ['<a :xlink:href="x">t</a>'],
    ['<form :action="x">t</form>'],
    ['<button :formaction="x">t</button>'],
    ['<a v-bind="attrs">t</a>'],
    ['<a v-bind="{ class: c }">t</a>'],
    ['<UrlLink v-bind="attrs" />'],
    ['<NuxtLink v-bind="attrs">t</NuxtLink>'],
    ['<div v-bind="attrs">t</div>'],
    ['<div v-bind="{ [k]: x }">t</div>'],
    ['<div v-bind="{ ...rest }">t</div>'],
    ['<div v-bind="{ HREF: x }">t</div>'],
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
    ['<img :src="x" />'],
    ['<form :action="safeHttpUrl(x)">t</form>'],
    ['<div v-bind="{ class: c, id: i }">t</div>'],
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
