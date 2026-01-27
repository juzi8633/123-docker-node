// ui/vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from "vite-plugin-singlefile"
import { createHtmlPlugin } from 'vite-plugin-html'

export default defineConfig({
  plugins: [
    vue(), 
    viteSingleFile(),
    createHtmlPlugin({
      minify: true,
    }),
  ],
  
  // --- 新增/修改 Server 配置 ---
  server: {
    host: '0.0.0.0',
    // 前端启动端口不用管（默认 5173），这里配置“请求转发”
    proxy: {
      // 场景 A: 如果你的前端请求都有统一前缀，比如 fetch('/api/list')
      '/api': {
        target: 'http://192.168.0.103:3000', // 后端地址
        changeOrigin: true,              // 允许跨域
        // rewrite: (path) => path.replace(/^\/api/, '') // 如果后端接口本身不带 /api，把这行注释打开
      },

      // 场景 B: 如果你的请求是根路径，比如 fetch('/login') 或 fetch('/file')
      // 你需要把具体的一级路径列出来进行转发：
      '/login': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/file': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // 注意：不要配置 '/'，否则会拦截前端页面的加载
    }
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    brotliSize: false,
    rollupOptions: {
      inlineDynamicImports: true,
    },
  },
})