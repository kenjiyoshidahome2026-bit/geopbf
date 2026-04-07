	import { defineConfig } from 'vite'
	import { resolve } from 'path'

	const banner = `/*!
	* geopbf.js v1.0.0
	* (c) 2026 Kenji Yoshida
	* Released under the MIT License.
	*/`;

	export default defineConfig({
	build: {
	  	sourcemap: true,
		rollupOptions: {
			output: {
				// 動的インポートを強制的に別ファイルへ分離
				codeSplitting: true, 
			},
			// Node.jsのポリフィルを絶対に入れないためのガード
			external: ['native-bucket', 'encoding-japanese', 'fast-sjis-encoder']
		},
	//	inlineDynamicImports: false,
    	minify: 'terser',
 		terserOptions: {
			format: {
				comments: /^\!/, // 「!」で始まるコメント（ライセンス等）を残す設定
				preamble: banner  // ファイルの最先端に必ずこれを置く設定
			}
		},
		lib: {
			entry: resolve(__dirname, 'src/geopbf.js'), 
			name: 'geopbf',
			fileName: 'geopbf',
			formats: ['esm']
		},
		outDir: 'dist',
	}
})