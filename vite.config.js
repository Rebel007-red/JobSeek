import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Serves netlify/functions/api at /.netlify/functions/api during `npm run dev`, so no Netlify CLI is needed locally.
function netlifyFunctionDev() {
  return {
    name: 'netlify-function-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/.netlify/functions/api', async (req, res) => {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const headers = {}
          for (const name of ['authorization', 'content-type']) {
            if (req.headers[name]) headers[name] = req.headers[name]
          }
          const request = new Request(`http://localhost${req.originalUrl || req.url}`, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          })
          const { default: handler } = await server.ssrLoadModule('/netlify/functions/api/index.mjs')
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: error.message }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Make .env (and databricks/.env) values visible to the function in dev, without overriding real env vars.
  const fileEnv = { ...loadEnv(mode, 'databricks', ''), ...loadEnv(mode, process.cwd(), '') }
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  return {
    plugins: [react(), tailwindcss(), netlifyFunctionDev()],
    build: {
      rollupOptions: {
        output: {
          // Libraries change rarely: separate files stay cached by browsers across app deploys
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('@supabase')) return 'supabase'
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react'
            return 'vendor'
          },
        },
      },
    },
  }
})
