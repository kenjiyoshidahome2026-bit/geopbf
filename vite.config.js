import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/PBF.js'), 
      name: 'geopbf',
      fileName: 'geopbf',
      formats: ['iife']
    },
    outDir: 'dist',
  }
})