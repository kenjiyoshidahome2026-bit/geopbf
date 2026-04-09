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
				'native-bucket': resolve(__dirname, '../native-bucket/src/index.js'), 
			}
		},
	    worker: {
			format: 'es', 
		},
		optimizeDeps: {
        	exclude: ['native-bucket']
    	},
	    build: {
        target: 'esnext',
        sourcemap: true,
        rollupOptions: {
            output: {
                codeSplitting: true, 
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
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