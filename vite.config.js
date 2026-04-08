import { defineConfig } from 'vite'
import { resolve } from 'path'

const banner = `/*!
* geopbf.js v1.0.0
* (c) 2026 Kenji Yoshida
* Released under the MIT License.
*/`;

export default defineConfig({
    worker: {
        format: 'es', 
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
            external: ['native-bucket', 'encoding-japanese', 'fast-sjis-encoder']
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