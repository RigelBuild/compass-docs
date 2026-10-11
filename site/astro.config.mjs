import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	integrations: [
		starlight({
			title: "Rigel public design docs",
			description:
				"Design records and decisions for Rigel's public repositories.",
			sidebar: [
				{
					label: "Designs",
					items: [{ autogenerate: { directory: "designs" } }],
				},
			],
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
		}),
	],
});
