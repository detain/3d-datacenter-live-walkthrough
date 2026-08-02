/**
 * tests/js/dc-ktx2.test.js — Step 8.2 KTX2 compressed texture support
 *
 * Verifies:
 * (a) KTX2Loader is imported and registered on loaderGltf
 * (b) loaderGltf.ktx2Loader.detectSupport(renderer) is called
 * (c) The docs/dc_asset_pipeline.md file exists and describes the pipeline
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_JS_SOURCE = fs.readFileSync(DC_JS, 'utf8');

const DOCS_PIPELINE = path.resolve(__dirname, '../../docs/dc_asset_pipeline.md');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KTX2Loader registration', () => {
	it('imports KTX2Loader from three/addons/loaders/KTX2Loader.js', () => {
		expect(DC_JS_SOURCE).toMatch(
			/import\s*{\s*KTX2Loader\s*}\s*from\s*["']three\/addons\/loaders\/KTX2Loader\.js["']/
		);
	});

	it('registers ktx2Loader on loaderGltf', () => {
		// loaderGltf.ktx2Loader = new KTX2Loader();
		expect(DC_JS_SOURCE).toMatch(/loaderGltf\.ktx2Loader\s*=\s*new\s+KTX2Loader\(\)/);
	});

	it('sets the transcoder path to the basis transcoder', () => {
		// loaderGltf.ktx2Loader.setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/');
		expect(DC_JS_SOURCE).toMatch(
			/loaderGltf\.ktx2Loader\.setTranscoderPath\(["']\/node_modules\/three\/examples\/jsm\/libs\/basis\/["']\)/
		);
	});

	it('calls detectSupport with renderer', () => {
		// loaderGltf.ktx2Loader.detectSupport(renderer);
		expect(DC_JS_SOURCE).toMatch(/loaderGltf\.ktx2Loader\.detectSupport\(renderer\)/);
	});
});

describe('KTX2 documentation', () => {
	it('docs/dc_asset_pipeline.md exists', () => {
		expect(fs.existsSync(DOCS_PIPELINE)).toBe(true);
	});

	it('describes the UASTC/ETC1S conversion pipeline', () => {
		const content = fs.readFileSync(DOCS_PIPELINE, 'utf8');
		expect(content).toContain('gltf-transform');
		expect(content).toContain('uastc');
		expect(content).toContain('etc1s');
	});

	it('notes that public_html/images/3d/ is gitignored', () => {
		const content = fs.readFileSync(DOCS_PIPELINE, 'utf8');
		expect(content).toMatch(/public_html\/images\/3d\/.*gitignore/i);
		expect(content).toContain('gitignored');
	});

	it('documents the transcoder path used in dc.js', () => {
		const content = fs.readFileSync(DOCS_PIPELINE, 'utf8');
		expect(content).toContain('/node_modules/three/examples/jsm/libs/basis/');
	});
});
