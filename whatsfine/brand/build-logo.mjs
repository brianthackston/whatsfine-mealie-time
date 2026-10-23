// Render the brand marks (mark.svg, mark-q.svg) to PNG with the real brand
// face. Mealie serves the logo through <img>, which cannot load web fonts, so
// the committed PNGs are what it uses; the SVGs are the editable source.
//
//   pnpm install          (once, in whatsfine/)
//   node build-logo.mjs   (from whatsfine/brand/)
//
// The font is fetched from Google Fonts the same way whatsfine.com's OG image
// route does (workers-og's loadGoogleFont): ask the CSS API with a user agent
// that predates woff2, and it hands back a TrueType URL, subset to the glyphs
// we name. Nothing is cached on disk.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const FAMILY = "Bricolage Grotesque";
// Variable axes, pinned: optical size 96 (display; the text size at 14 is
// visibly narrower than the site's wordmark), width 100, weight 800.
const AXES = "opsz,wdth,wght@96,100,800";
const MARKS = [
	{ svg: "mark.svg", png: "mark.png", text: "WF?" },
	{ svg: "mark-q.svg", png: "mark-q.png", text: "?" },
];
const SIZE = 512;

async function fetchFont(text) {
	const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FAMILY)}:${AXES}&text=${encodeURIComponent(text)}`;
	const res = await fetch(css, {
		// Safari 5 predates woff, so the API answers with truetype (a woff-era UA
		// gets woff, which resvg cannot read). Same UA workers-og uses.
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1",
		},
	});
	if (!res.ok) throw new Error(`font css: ${res.status} ${res.statusText}`);
	const url = (await res.text()).match(/src:\s*url\(([^)]+)\)\s*format\(['"]truetype['"]\)/)?.[1];
	if (!url) throw new Error("Google Fonts did not return a truetype URL; is the UA trick still honoured?");
	const ttf = await fetch(url);
	if (!ttf.ok) throw new Error(`font file: ${ttf.status} ${ttf.statusText}`);
	return Buffer.from(await ttf.arrayBuffer());
}

for (const mark of MARKS) {
	const font = await fetchFont(mark.text);
	const svg = await readFile(join(here, mark.svg), "utf8");
	const png = new Resvg(svg, {
		fitTo: { mode: "width", value: SIZE },
		font: { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: FAMILY },
	})
		.render()
		.asPng();
	await writeFile(join(here, mark.png), png);
	console.log(`${mark.png}  ${SIZE}x${SIZE}  ${png.length} bytes`);
}
