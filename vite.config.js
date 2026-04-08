import { defineConfig } from 'vite'
import { resolve } from 'path'

const banner = `/*!
* geopbf.js v1.0.0
* (c) 2026 Kenji Yoshida
* Released under the MIT License.
*/`;

export default defineConfig({
		resolve: {
			alias: {
				// "native-bucket" というインポートを、ローカルのソースファイルに直接紐付ける
				'native-bucket': resolve(__dirname, '../native-bucket/src/index.js'), 
				// ↑ もしエントリポイントが index.js でない場合は、正しいファイルパスに変えてください
			}
		},
	    worker: {
			format: 'es', 
		},
		optimizeDeps: {
        	include: ['native-bucket'] // 開発時に強制的にバンドルに含める
    	},
	    build: {
        target: 'esnext', // 修正: arget -> target
        sourcemap: true,
        rollupOptions: {
            output: {
                // Vite 8 では inlineDynamicImports: false の代わりに 
                // codeSplitting: true を使用して分割を明示します
                codeSplitting: true, 
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
            // Node.jsのポリフィルを混入させないための設定
            external: [ 'encoding-japanese']
        },
        minify: 'terser',
        terserOptions: {
            format: {
                comments: /^\!/, 
                preamble: banner  
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