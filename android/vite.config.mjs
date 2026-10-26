import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here=path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root:path.join(here,'ui'), base:'./',
  esbuild:{jsx:'automatic'},
  build:{outDir:path.join(here,'app/src/main/assets/ui'),emptyOutDir:true},
})
